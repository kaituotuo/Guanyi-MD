# Guanyi‑MD

**观绎 MD｜俯仰观物，绎述我心。**

## Overview

Guanyi‑MD is a local-first Markdown reader and editor centered on the writer. It runs directly in Chrome or Edge, works with any Markdown document, can ingest local folders, and provides Smart Review for human comments and user-triggered AI-assisted reading.

## Common Use Cases

- Read, draft, and organize plans, notes, and technical documentation
- Review and refine AI-generated Markdown
- Write in offline or intranet environments
- Export content as Markdown, PDF, or a full-page PNG

## Key Features

1. **Three editing views**: Source, Preview, and Split.
2. **Formatting tools**: Headings, emphasis, lists, quotes, code, and tables.
3. **Local document management**: Create browser documents or open local text files.
4. **Undo and redo**: Each document keeps its own recent editing history.
5. **Flexible export**: Download the Markdown source or export the rendered preview.
6. **Add Folder**: Authorize multiple Markdown folders and browse their original hierarchy.
7. **Safe write-back**: Save to the original file with external-change conflict protection.
8. **Smart Review — comments**: Comment on exact text or a whole block, then view, edit, delete, and generate AI-readable sidecars without changing the Markdown body.
9. **Smart Review — AI-assisted reading**: Track reading progress and use a user-configured OpenAI-compatible model for highlights, key details, and conflict warnings with source locations.
10. **Model and key safety**: Connection tests do not send the document. API keys are session-only by default, and an optional loopback-only proxy handles browser network restrictions without persisting requests.

## Collaboration Extension Status

- Implemented: folder ingestion, tree browsing, write-back, conflict protection, comments, review sidecars, reading progress, and AI-assisted reading.
- Postponed: feedback tasks, automatic rewriting, change comparison, and item-by-item confirmation.

## Data and Files

- Browser documents are stored in `localStorage`.
- Files opened through Chrome or Edge can be written back after permission is granted.
- Removing a local file from the sidebar does not delete the original file from disk.
- The current Markdown is sent only when the user generates reading assistance. API keys stay session-only by default and never enter the document or review sidecars.

## Get Started

Choose a document from the sidebar to read or edit, or use Add Folder to bring a local Markdown folder into the document tree. Select text and use the toolbar Smart Review icon to open Comments or AI-assisted Reading.
