# Origin

research-core is derived from [gbrain](https://github.com/garrytan/gbrain) by Garry Tan.

The core engine, search, chunking, and graph primitives are adapted from gbrain's
PGLiteEngine and related modules. Key modifications:

- Local GGUF embeddings via node-llama-cpp (replaces OpenAI embedding service)
- Local reranking step (qwen3-reranker) added to hybrid search pipeline
- Source/context data model for multi-context research workflows
- Text-PDF normalization pipeline
- Custom MCP tool contract for Vervo app integration

gbrain is licensed under MIT. See LICENSE.
