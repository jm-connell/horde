# 0018. Ask about Horde answers from shipped docs and source by keyword retrieval

Status: Accepted

## Context

People ask how to set up and use Horde, and the answers are in the wiki and, for the details, in the code. The repository is public, so a chat model could read it, but the usual ways to give a model a codebase each cost something here: the docs alone are about 660 KB of Markdown and the source about 4 MB, far beyond the context window of the small local models many installs run; tool calling (letting the model ask for files) works only with some models and providers and needs several round trips per answer; fetching from GitHub at question time needs internet access and may describe a different version than the one installed; embeddings need an embedding model and an indexing job.

## Decision

- **Ship the text with the image.** The Dockerfile copies `docs/`, the root Markdown files Horde reads (`README.md`, `PRODUCT.md`, `DESIGN.md`, `CHANGELOG.md`, `CONTRIBUTING.md`), `.env.example`, `docker-compose.yml` and `frontend/src` to `/app/source`; the backend source is the running package. A checkout reads the repository itself. Answers therefore describe the installed version and need no network beyond the chat provider.
- **Keyword retrieval, built in memory.** `services/ai/help_chat.py` splits Markdown by heading and code into 60-line windows, and ranks them with BM25 (identifiers also split into their camelCase and snake_case parts; docs weighted above code unless the question is about code). The index is built on the first question (about a second) and kept on the `AppContext`. Each question gets `docs/features.md` as an overview plus about 16,000 characters of the best excerpts, a few per file at most, and the previous question's terms at half weight for follow-ups.
- **No stored conversation.** The client sends the last turns with each question (`POST /api/ai/help/chat`, at most 24); the browser keeps the thread in `sessionStorage`. There is no table and no migration. The chat turn itself reuses `run_chat_turn` (streaming, auth re-checks, cost booking) with its own system prompt, and a `sources` event lists the pages and files given to the model.

## Consequences

- Works with any chat model, local or cloud, with no embedding model or background job; a local model needs about an 8K-token context window.
- Retrieval is lexical: a question phrased in words the docs never use may get weak excerpts. The model is told to say so rather than guess, and the sources are shown so a reader can check.
- The model cannot follow a reference into another file on its own; it sees only the excerpts picked for the question. Tool calling could be added later for models that support it.
- The image is about 5 MB larger.
