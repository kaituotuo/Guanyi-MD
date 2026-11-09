# Guanyi Reader

**观译阅读器｜让阅读、摘录与思考留在本地。**

## Overview

Guanyi Reader is a local reading and annotation tool for Markdown, TXT, PDF, and EPUB. It edits Markdown and TXT text and provides highlights, comments, and notes for PDF and EPUB. The toolbar adapts to the open format while retaining a consistent icon style.

## Common Use Cases

- Read, draft, and organize plans, notes, and technical documentation
- Read and annotate PDF reference material, then save a PDF with annotations
- Read EPUB books by chapter and export excerpts and notes
- Review and refine AI-generated Markdown
- Write in offline or intranet environments
- Export content as Markdown, PDF, or a full-page PNG

## Key Features

1. **Markdown editing**: Source, Preview, and Split views with headings, emphasis, lists, quotes, code, and tables.
2. **TXT reading and editing**: Read and edit plain text while preserving its original line breaks.
3. **PDF reading and annotations**: Page navigation, zoom, search, highlights, comments, and notes; save a PDF containing annotations.
4. **EPUB reading and notes**: Chapters, pagination, font sizes, restored reading position, highlights, and notes exported as Markdown.
5. **Markdown export and history**: Undo or redo recent edits and export Markdown source, PDF, or a full-page PNG.
6. **Add Folder**: Authorize multiple Markdown folders and browse their original hierarchy.
7. **Safe text write-back**: Save Markdown and TXT to the original file with external-change conflict protection.
8. **Markdown Smart Review — comments**: Comment on exact text or a whole block, then view, edit, delete, and generate AI-readable sidecars without changing the Markdown body.
9. **Markdown AI-assisted reading**: Track reading progress and use a user-configured OpenAI-compatible model for highlights, key details, and conflict warnings with source locations.
10. **Model and key safety**: Connection tests do not send the document. API keys are session-only by default, and an optional loopback-only proxy handles browser network restrictions without persisting requests.

## Collaboration Extension Status

- Implemented: folder ingestion, tree browsing, write-back, conflict protection, comments, review sidecars, reading progress, and AI-assisted reading.
- Postponed: feedback tasks, automatic rewriting, change comparison, and item-by-item confirmation.

## Data and Files

- Text progress and reading records are stored locally; PDF annotation drafts and original EPUB files use a local cache.
- Markdown and TXT files opened through Chrome or Edge can be written back after permission is granted.
- Save As exports a PDF containing annotations. EPUB originals stay unchanged; their highlights and notes are stored in the app and exported separately.
- Removing a local file from the sidebar does not delete the original file from disk.
- The current Markdown is sent only when the user generates reading assistance. API keys stay session-only by default and never enter the document or review sidecars.

## Get Started

Use Open Document to choose Markdown, TXT, PDF, or EPUB. Edit Markdown and TXT directly, or use the PDF and EPUB reading tools to highlight passages and add notes. Add Folder brings Markdown and TXT folders into the document tree. Markdown Smart Review provides comments and AI-assisted reading.
