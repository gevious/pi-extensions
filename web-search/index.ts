import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WebSearchParamsSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    count: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Max results (1-20), default 5",
    },
    topic: {
      type: "string",
      description: "Tavily topic",
      enum: ["general", "news"],
    },
    timeRange: {
      type: "string",
      description: "Optional time range filter",
      enum: ["day", "week", "month", "year"],
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

type WebSearchParams = {
  query: string;
  count?: number;
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
};

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
};

type TavilyResponse = {
  answer?: string;
  query?: string;
  results?: TavilyResult[];
};

function formatResults(results: TavilyResult[]): string {
  if (results.length === 0) return "No results.";

  return results
    .map((r, i) => {
      const title = r.title ?? "(no title)";
      const url = r.url ?? "(no url)";
      const snippet = (r.content ?? "").replace(/\s+/g, " ").trim();
      const score = typeof r.score === "number" ? `\nScore: ${r.score.toFixed(3)}` : "";
      const published = r.published_date ? `\nPublished: ${r.published_date}` : "";
      return `${i + 1}. ${title}\nURL: ${url}${score}${published}${snippet ? `\nSnippet: ${snippet}` : ""}`;
    })
    .join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search web using Tavily API and return top results.",
    promptSnippet: "Search web for up-to-date info with web_search, include sources.",
    promptGuidelines: [
      "Use web_search when user asks for recent external info not in local files.",
      "After web_search, cite URLs from returned results.",
    ],
    parameters: WebSearchParamsSchema,
    async execute(_toolCallId, params: WebSearchParams) {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Missing Tavily API key. Set TAVILY_API_KEY." }],
          details: { missingApiKey: true },
          isError: true,
        };
      }

      const maxResults = params.count ?? 5;
      const payload = {
        api_key: apiKey,
        query: params.query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: true,
        include_images: false,
        topic: params.topic ?? "general",
        ...(params.timeRange ? { time_range: params.timeRange } : {}),
      };

      let response: Response;
      try {
        response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Tavily request failed: ${msg}` }],
          details: { error: msg },
          isError: true,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          content: [{ type: "text", text: `Tavily API error ${response.status}: ${body || response.statusText}` }],
          details: { status: response.status, body },
          isError: true,
        };
      }

      const data = (await response.json()) as TavilyResponse;
      const results = data.results ?? [];
      const top = results.slice(0, maxResults);
      const answerBlock = data.answer ? `Answer: ${data.answer}\n\n` : "";

      return {
        content: [{ type: "text", text: `${answerBlock}Query: ${params.query}\n\n${formatResults(top)}` }],
        details: {
          query: params.query,
          answer: data.answer,
          count: top.length,
          results: top,
        },
      };
    },
  });
}
