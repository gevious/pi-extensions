import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type StoryStatus = "pending" | "running" | "done" | "failed";

type ResultStatus = "done" | "failed";

type JsonPlanFile = {
    feature?: string;
    source?: string;
    codebase?: string;
    stories?: Array<{
        id: string;
        title: string;
        status?: string;
        blockedBy?: string[];
        covers?: string[];
        tasks?: string[];
        acceptanceCriteria?: string[];
        techGuidance?: string;
        skill?: string;
    }>;
    issues?: Array<{
        id: number | string;
        title: string;
        status?: string;
        blockedBy?: Array<number | string>;
        description?: string;
        acceptanceCriteria?: string[];
        skill?: string;
    }>;
};

type Story = {
    id: string;
    title: string;
    deps: string[];
    prompt: string;
    initialStatus: StoryStatus;
    skill: string;
};

type Plan = {
    version: 1;
    feature?: string;
    codebase?: string;
    stories: Story[];
};

type Checkpoint = {
    planFile: string;
    updatedAt: string;
    stories: Record<
        string,
        {
            status: StoryStatus;
            startedAt?: string;
            finishedAt?: string;
            error?: string;
            summary?: string;
        }
    >;
};

type StoryResult = {
    status: ResultStatus;
    summary?: string;
};

const STATE_DIR = ".story-executor";
const CHECKPOINT_FILE = "checkpoint.json";
const RESULTS_DIR = "results";
const DEFAULT_SKILL = "coding-mode";

export default function storyExecutor(pi: ExtensionAPI) {
    pi.registerCommand("story-run-all", {
        description:
            "Execute every story in dependency order, one fresh session per story, using coding-mode skill",
        handler: async (args, ctx) => {
            const options = parseArgs(args || "");
            const planFile = options.file || "issues.json";

            const cwd = ctx.cwd;
            const stateDir = path.resolve(cwd, STATE_DIR);
            const checkpointPath = path.resolve(stateDir, CHECKPOINT_FILE);
            const resultsDir = path.resolve(stateDir, RESULTS_DIR);

            await mkdir(resultsDir, { recursive: true });

            const plan = await readPlan(path.resolve(cwd, planFile));
            validatePlan(plan);

            if (options.reset) {
                await rm(resultsDir, { recursive: true, force: true });
                await mkdir(resultsDir, { recursive: true });
            }

            const checkpoint = options.reset
                ? freshCheckpoint(planFile, plan, true)
                : await readCheckpoint(checkpointPath, planFile, plan);

            await writeCheckpoint(checkpointPath, checkpoint);

            const completed: string[] = [];
            const failed: string[] = [];

            while (true) {
                const story = getNextRunnableStory(plan, checkpoint);
                if (!story) break;

                checkpoint.stories[story.id] = {
                    ...checkpoint.stories[story.id],
                    status: "running",
                    startedAt: now(),
                    finishedAt: undefined,
                    error: undefined,
                    summary: undefined,
                };
                checkpoint.updatedAt = now();
                await writeCheckpoint(checkpointPath, checkpoint);

                const resultFile = path.resolve(resultsDir, `${safeFileName(story.id)}.json`);
                const parentSession = ctx.sessionManager.getSessionFile();
                const kickoff = buildStoryPrompt({
                    story,
                    plan,
                    resultFile: path.relative(cwd, resultFile),
                    checkpointFile: path.relative(cwd, checkpointPath),
                });

                try {
                    const result = await ctx.newSession({
                        parentSession,
                        setup: async (sm) => {
                            sm.appendMessage({
                                role: "user",
                                timestamp: Date.now(),
                                content: [
                                    {
                                        type: "text",
                                        text: [
                                            "Story executor fresh session.",
                                            "Previous story context is intentionally unavailable.",
                                            `Required skill: ${story.skill}`,
                                            `Story ID: ${story.id}`,
                                        ].join("\n"),
                                    },
                                ],
                            });
                        },
                        withSession: async (freshCtx) => {
                            await freshCtx.sendUserMessage(kickoff);
                        },
                    });

                    if (result.cancelled) {
                        markFailed(checkpoint, story.id, "Fresh session was cancelled.");
                        failed.push(story.id);
                        await writeCheckpoint(checkpointPath, checkpoint);
                        break;
                    }

                    const storyResult = await readStoryResult(resultFile);

                    if (storyResult.status !== "done") {
                        markFailed(
                            checkpoint,
                            story.id,
                            storyResult.summary || "Story result file reported failed.",
                        );
                        failed.push(story.id);
                        await writeCheckpoint(checkpointPath, checkpoint);
                        break;
                    }

                    checkpoint.stories[story.id] = {
                        ...checkpoint.stories[story.id],
                        status: "done",
                        finishedAt: now(),
                        error: undefined,
                        summary: storyResult.summary,
                    };
                    checkpoint.updatedAt = now();

                    await writeCheckpoint(checkpointPath, checkpoint);
                    completed.push(story.id);
                } catch (error) {
                    markFailed(
                        checkpoint,
                        story.id,
                        error instanceof Error ? error.message : String(error),
                    );
                    failed.push(story.id);
                    await writeCheckpoint(checkpointPath, checkpoint);
                    break;
                }
            }

            ctx.ui.notify(
                [
                    `story-run-all complete`,
                    `completed=${completed.length}${completed.length ? ` [${completed.join(", ")}]` : ""}`,
                    failed.length ? `failed=${failed.join(", ")}` : "",
                    summarize(plan, checkpoint),
                ]
                    .filter(Boolean)
                    .join("\n"),
                failed.length ? "error" : "success",
            );
        },
    });

    pi.registerCommand("story-status", {
        description: "Show story execution status",
        handler: async (args, ctx) => {
            const planFile = args?.trim() || "issues.json";
            const plan = await readPlan(path.resolve(ctx.cwd, planFile));
            validatePlan(plan);

            const checkpointPath = path.resolve(ctx.cwd, STATE_DIR, CHECKPOINT_FILE);
            const checkpoint = await readCheckpoint(checkpointPath, planFile, plan);

            ctx.ui.notify(
                plan.stories
                    .map((story) => {
                        const status = checkpoint.stories[story.id]?.status ?? "pending";
                        const deps = story.deps.length ? ` deps=[${story.deps.join(", ")}]` : "";
                        return `${status.padEnd(7)} ${story.id} ${story.title}${deps}`;
                    })
                    .join("\n"),
                "info",
            );
        },
    });

    pi.registerCommand("story-reset", {
        description: "Reset story executor checkpoint and results",
        handler: async (_args, ctx) => {
            const stateDir = path.resolve(ctx.cwd, STATE_DIR);
            await rm(stateDir, { recursive: true, force: true });
            ctx.ui.notify("Story executor state reset.", "success");
        },
    });
}

async function readPlan(file: string): Promise<Plan> {
    const raw = await readFile(file, "utf8");

    if (!file.endsWith(".json")) {
        throw new Error("Only JSON plan files are supported.");
    }

    const parsed = JSON.parse(raw) as JsonPlanFile;

    if (Array.isArray(parsed.stories)) {
        return parseStoriesJson(parsed);
    }

    if (Array.isArray(parsed.issues)) {
        return parseIssuesJson(parsed);
    }

    throw new Error("Unsupported JSON plan format. Expected stories[] or issues[].");
}

function parseStoriesJson(input: JsonPlanFile): Plan {
    return {
        version: 1,
        feature: input.feature,
        codebase: input.codebase,
        stories: (input.stories ?? []).map((story) => ({
            id: story.id,
            title: story.title,
            deps: story.blockedBy ?? [],
            initialStatus: normalizeStatus(story.status),
            skill: story.skill || DEFAULT_SKILL,
            prompt: [
                input.feature ? `Feature: ${input.feature}` : "",
                input.codebase ? `Codebase: ${input.codebase}` : "",
                "",
                `Story ${story.id}: ${story.title}`,
                "",
                story.techGuidance ? `Technical guidance:\n${story.techGuidance}` : "",
                "",
                story.tasks?.length
                    ? ["Tasks:", ...story.tasks.map((task) => `- ${task}`)].join("\n")
                    : "",
                "",
                story.acceptanceCriteria?.length
                    ? [
                        "Acceptance criteria:",
                        ...story.acceptanceCriteria.map((item) => `- ${item}`),
                    ].join("\n")
                    : "",
            ]
                .filter((part) => part.trim().length > 0)
                .join("\n"),
        })),
    };
}

function parseIssuesJson(input: JsonPlanFile): Plan {
    return {
        version: 1,
        feature: input.feature,
        codebase: input.codebase,
        stories: (input.issues ?? []).map((issue) => ({
            id: `issue-${issue.id}`,
            title: issue.title,
            deps: (issue.blockedBy ?? []).map((id) => `issue-${id}`),
            initialStatus: normalizeStatus(issue.status),
            skill: issue.skill || DEFAULT_SKILL,
            prompt: [
                input.feature ? `Feature: ${input.feature}` : "",
                input.codebase ? `Codebase: ${input.codebase}` : "",
                "",
                `Issue ${issue.id}: ${issue.title}`,
                "",
                issue.description ? `Description:\n${issue.description}` : "",
                "",
                issue.acceptanceCriteria?.length
                    ? [
                        "Acceptance criteria:",
                        ...issue.acceptanceCriteria.map((item) => `- ${item}`),
                    ].join("\n")
                    : "",
            ]
                .filter((part) => part.trim().length > 0)
                .join("\n"),
        })),
    };
}

function normalizeStatus(status?: string): StoryStatus {
    if (status === "done") return "done";
    if (status === "failed") return "failed";
    return "pending";
}

async function readCheckpoint(
    file: string,
    planFile: string,
    plan: Plan,
): Promise<Checkpoint> {
    try {
        const checkpoint = JSON.parse(await readFile(file, "utf8")) as Checkpoint;

        for (const story of plan.stories) {
            checkpoint.stories[story.id] ??= {
                status: story.initialStatus,
            };
        }

        return checkpoint;
    } catch {
        return freshCheckpoint(planFile, plan, false);
    }
}

function freshCheckpoint(planFile: string, plan: Plan, forcePending: boolean): Checkpoint {
    return {
        planFile,
        updatedAt: now(),
        stories: Object.fromEntries(
            plan.stories.map((story) => [
                story.id,
                {
                    status: forcePending ? "pending" : story.initialStatus,
                },
            ]),
        ),
    };
}

async function writeCheckpoint(file: string, checkpoint: Checkpoint) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function validatePlan(plan: Plan) {
    const ids = new Set<string>();

    for (const story of plan.stories) {
        if (!story.id) throw new Error("Story missing id.");
        if (!story.title) throw new Error(`Story ${story.id} missing title.`);
        if (!story.prompt) throw new Error(`Story ${story.id} missing prompt.`);
        if (ids.has(story.id)) throw new Error(`Duplicate story id: ${story.id}`);
        ids.add(story.id);
    }

    for (const story of plan.stories) {
        for (const dep of story.deps) {
            if (!ids.has(dep)) {
                throw new Error(`${story.id} depends on unknown story ${dep}`);
            }
        }
    }

    assertAcyclic(plan);
}

function assertAcyclic(plan: Plan) {
    const byId = new Map(plan.stories.map((story) => [story.id, story]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function visit(id: string) {
        if (visited.has(id)) return;
        if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);

        visiting.add(id);

        for (const dep of byId.get(id)?.deps ?? []) {
            visit(dep);
        }

        visiting.delete(id);
        visited.add(id);
    }

    for (const story of plan.stories) {
        visit(story.id);
    }
}

function getNextRunnableStory(plan: Plan, checkpoint: Checkpoint): Story | null {
    for (const story of plan.stories) {
        const status = checkpoint.stories[story.id]?.status ?? "pending";
        if (status !== "pending") continue;

        const depsDone = story.deps.every(
            (dep) => checkpoint.stories[dep]?.status === "done",
        );

        if (depsDone) return story;
    }

    return null;
}

function buildStoryPrompt(input: {
    story: Story;
    plan: Plan;
    resultFile: string;
    checkpointFile: string;
}) {
    const { story, plan, resultFile, checkpointFile } = input;

    return [
        `Use the ${story.skill} skill.`,
        "",
        "Execute exactly one story.",
        "The context has been reset for this story. Do not rely on prior story conversation.",
        "Do not work on dependent, sibling, or future stories.",
        "",
        plan.feature ? `Feature: ${plan.feature}` : "",
        plan.codebase ? `Codebase: ${plan.codebase}` : "",
        "",
        story.prompt,
        "",
        "Execution rules:",
        `- Required skill: ${story.skill}`,
        `- Before modifying files, explicitly follow the ${story.skill} skill workflow.`,
        "- Keep changes scoped to this story only.",
        "- Do not continue to the next story.",
        "- Run relevant tests/type checks for this story.",
        "- If blocked, fail this story and explain why in the result file.",
        "- Before ending, write the result JSON file.",
        "",
        `Checkpoint file: ${checkpointFile}`,
        `Result file: ${resultFile}`,
        "",
        "Required result JSON shape:",
        `{ "status": "done" | "failed", "summary": "short summary" }`,
    ]
        .filter((part) => part.trim().length > 0)
        .join("\n");
}

async function readStoryResult(file: string): Promise<StoryResult> {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as StoryResult;

    if (parsed.status !== "done" && parsed.status !== "failed") {
        throw new Error(`Invalid story result status in ${file}`);
    }

    return parsed;
}

function markFailed(checkpoint: Checkpoint, storyId: string, error: string) {
    checkpoint.stories[storyId] = {
        ...checkpoint.stories[storyId],
        status: "failed",
        finishedAt: now(),
        error,
    };
    checkpoint.updatedAt = now();
}

function summarize(plan: Plan, checkpoint: Checkpoint): string {
    const counts: Record<StoryStatus, number> = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
    };

    for (const story of plan.stories) {
        counts[checkpoint.stories[story.id]?.status ?? "pending"]++;
    }

    return `done=${counts.done}, pending=${counts.pending}, running=${counts.running}, failed=${counts.failed}`;
}

function parseArgs(raw: string): { file?: string; reset: boolean } {
    const parts = raw.trim().split(/\s+/).filter(Boolean);

    return {
        file: parts.find((part) => !part.startsWith("--")),
        reset: parts.includes("--reset"),
    };
}

function safeFileName(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function now() {
    return new Date().toISOString();
}
