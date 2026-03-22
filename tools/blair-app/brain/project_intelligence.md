# Project Intelligence

## Project State Tracking

Every project maintains a live state object:

```
{
  project_name,
  project_directory,
  dev_framework,        // vite, next, create-react-app, etc.
  dev_server_command,    // npm run dev, npx vite, etc.
  dev_port,             // 5173, 3000, 8080, etc.
  preview_url,          // http://localhost:5173
  last_updated_files,   // [file1.js, file2.css]
  last_edit_summary,    // "Added login form"
  last_commit_time      // ISO timestamp
}
```

## Framework Detection

Auto-detect framework and dev port from project files:

| Signal | Framework | Port |
|--------|-----------|------|
| vite.config.* | Vite | 5173 |
| next.config.* | Next.js | 3000 |
| angular.json | Angular | 4200 |
| vue.config.* | Vue CLI | 8080 |
| package.json scripts.start | CRA/Other | 3000 |
| server.js with PORT | Custom Node | from code |

## Code Change Workflow

ALL code changes follow this pipeline:

1. **Analyze** — Understand the request scope
2. **Route** — Small change → Haiku, Large change → Sonnet
3. **Execute** — Use Claude Code tools (never raw chat output)
4. **Update State** — Record changed files, summary, timestamp
5. **Check Server** — Verify dev server is running
6. **Report** — Return formatted response with preview link

## Model Routing for Code

**Haiku-tier tasks** (fast, cheap):
- Text/label changes
- CSS/style tweaks
- Single-file edits
- Config updates
- Simple bug fixes

**Sonnet-tier tasks** (deep reasoning):
- New features
- Multi-file changes
- Architecture decisions
- Complex logic
- Refactoring

## Response Format

After every completed change:

```
CHANGE COMPLETE

Files Updated:
- file1.js
- file2.css

Model Used: [tier]

Preview Link: [url]

Commit Summary: [description]
```

## Dev Server Rules

Before returning a preview link:
1. Check if dev server process is running
2. If not → start it automatically
3. Confirm port is correct
4. Return verified URL

## Never Do

- Never output raw code in chat as the implementation
- Never guess preview URLs — detect them
- Never skip state updates after changes
- Never forget to check dev server status
