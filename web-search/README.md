# web-search (Tavily)

Pi extension adding `web_search` tool backed by Tavily Search API.

## Setup

1. Get API key: https://tavily.com/
2. Export key:

```bash
export TAVILY_API_KEY=your_key_here
```

3. Load extension:

```bash
pi -e ./web-search/index.ts
```

Or copy `index.ts` into `~/.pi/agent/extensions/` then run `/reload`.

## Tool

`web_search` params:
- `query` (string, required)
- `count` (1-20, optional, default 5)
- `topic` (`general|news`, optional, default `general`)
- `timeRange` (`day|week|month|year`, optional)
