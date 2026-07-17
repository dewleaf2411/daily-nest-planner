import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "Server missing LOVABLE_API_KEY. Voice transcription is unavailable." }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response(JSON.stringify({ error: "Expected multipart/form-data upload." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) {
          return new Response(JSON.stringify({ error: "No audio file received." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (file.size < 1024) {
          return new Response(
            JSON.stringify({ error: "Recording was too short. Try again and speak for at least a second." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (file.size > 20 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Recording too large (>20MB)." }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }

        const mime = (file.type || "").split(";")[0];
        const ext =
          ({ "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" } as Record<string, string>)[mime] ||
          "webm";

        const upstream = new FormData();
        upstream.append("model", "openai/gpt-4o-mini-transcribe");
        upstream.append("file", file, `recording.${ext}`);

        const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: upstream,
        });

        const bodyText = await res.text();
        if (!res.ok) {
          let message = bodyText;
          try {
            const parsed = JSON.parse(bodyText);
            message = parsed?.error?.message || parsed?.error || bodyText;
          } catch { /* keep bodyText */ }
          if (res.status === 402) {
            message = "AI credits exhausted. Add credits to keep using voice transcription.";
          } else if (res.status === 429) {
            message = "Voice transcription is rate-limited. Please try again in a moment.";
          }
          return new Response(JSON.stringify({ error: message }), {
            status: res.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const parsed = JSON.parse(bodyText);
          return new Response(JSON.stringify({ text: parsed.text ?? "" }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify({ text: bodyText }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
