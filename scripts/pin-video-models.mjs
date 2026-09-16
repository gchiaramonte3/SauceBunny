// Explicit maintainer operation: print a model manifest; never download weights.
// Small tokenizer/config files are hashed too. Runtime never queries `main`.
import { createHash } from "node:crypto";

const models = [
  { id: "qwen3-vl-embedding-2b", role: "embedding", name: "Qwen3-VL Embedding 2B", repo: "mlx-community/Qwen3-VL-Embedding-2B-4bit", revision: "c713a965783416b9467b419f2d14ca6445847455" },
  { id: "qwen3-vl-reranker-2b", role: "reranker", name: "Qwen3-VL Reranker 2B", repo: "mlx-community/Qwen3-VL-Reranker-2B-4bit", revision: "374a7dc08e7c3b553c8b2730a425e53c7a926510" },
  { id: "qwen3.5-9b-video", role: "reasoning", name: "Qwen3.5 9B", repo: "mlx-community/Qwen3.5-9B-4bit", revision: "8b2b98c00a6b4d291155e4890773ca8f769aee53" },
];

async function checked(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model metadata returned ${response.status}`);
  return response;
}

for (const model of models) {
  const metadata = await (await checked(`https://huggingface.co/api/models/${model.repo}/revision/${model.revision}?blobs=true`)).json();
  if (metadata.sha !== model.revision) throw new Error("Model revision mismatch");
  model.files = [];
  for (const file of metadata.siblings) {
    const name = file.rfilename;
    if (!/^[\w.-]+\.(json|jinja|safetensors)$/.test(name)) continue;
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Missing model file size");
    let sha256 = file.lfs?.sha256;
    if (!sha256) {
      if (file.size > 32 * 1024 * 1024) throw new Error("Large file has no upstream SHA-256");
      const bytes = Buffer.from(await (await checked(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${name}`)).arrayBuffer());
      if (bytes.length !== file.size) throw new Error("Model file size mismatch");
      sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
    model.files.push({ name, bytes: file.size, sha256 });
  }
  model.bytes = model.files.reduce((sum, file) => sum + file.bytes, 0);
}
process.stdout.write(`${JSON.stringify({ schema_version: 1, models }, null, 2)}\n`);
