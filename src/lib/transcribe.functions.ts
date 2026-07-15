import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
});

function extFor(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  switch (base) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    default:
      return "webm";
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.split(",", 2)[1] : b64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<{ text: string }> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      throw new Error("Voice input needs an AI key. Type your notes instead, or ask your admin to enable Lovable AI.");
    }

    const bytes = base64ToUint8Array(data.audioBase64);
    const ext = extFor(data.mimeType);
    const blob = new Blob([bytes], { type: data.mimeType });

    const form = new FormData();
    form.append("model", "openai/gpt-4o-mini-transcribe");
    form.append("file", blob, `recording.${ext}`);

    const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Lovable-API-Key": key,
      },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Transcription failed", res.status, body);
      throw new Error(`Transcription failed (${res.status}). Please try again.`);
    }

    const json = (await res.json()) as { text?: string };
    return { text: (json.text ?? "").trim() };
  });
