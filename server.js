import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import morgan from "morgan";
import path from "path";
import { toFile } from "openai/uploads"; // 👈 IMPORTANTE

const app = express();

// ====== LOG BÁSICO DE TODAS AS REQUISIÇÕES ======
app.use(
    morgan(
        '[:date[iso]] :remote-addr :method :url :status :res[content-length] - :response-time ms ":user-agent"'
    )
);
app.use(cors());
// aumenta limites p/ payloads de texto/json se precisar
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ limit: "2mb", extended: true }));

// ====== Multer p/ uploads (logs de arquivo também) ======
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 50 * 1024 * 1024 }, // até 50MB
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// helper p/ logar início/fim de rota com duração
function withTiming(name, handler) {
    return async (req, res) => {
        const start = Date.now();
        const rid = Math.random().toString(36).slice(2, 8);
        const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
        const ua = req.headers["user-agent"] || "-";

        console.log(`[${name}] [${rid}] START ip=${ip} ua="${ua}"`);

        try {
            await handler(req, res, (extra = {}) => {
                const ms = Date.now() - start;
                console.log(
                    `[${name}] [${rid}] OK ${ms}ms ${JSON.stringify(extra)}`
                );
            });
        } catch (err) {
            const ms = Date.now() - start;
            console.error(`[${name}] [${rid}] ERROR ${ms}ms`, err);
            res.status(500).json({ error: `${name}_failed` });
        }
    };
}

// ====== /status simples (e opcionalmente pinga a OpenAI) ======
app.get("/status", async (req, res) => {
    const payload = {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || "development",
    };

    if (process.env.PING_OPENAI === "1") {
        try {
            await openai.models.list();
            payload.openai = "reachable";
        } catch (e) {
            payload.openai = "unreachable";
            payload.openai_error = String(e?.message || e);
            res.status(500);
        }
    }

    res.json(payload);
});

// ====== /transcribe (STT) ======
// app.post(
//     "/transcribe",
//     upload.single("audio"),
//     withTiming("transcribe", async (req, res, done) => {
//         if (!req.file) {
//             res.status(400).json({ error: "no_file" });
//             return done({ error: "no_file" });
//         }

//         const { originalname, mimetype, size, path: tmpPath } = req.file;
//         console.log(
//             `[transcribe] file name="${originalname}" type=${mimetype} size=${size}B tmp=${tmpPath}`
//         );

//         let transcriptText = "";
//         try {
//             const stream = fs.createReadStream(tmpPath);

//             const result = await openai.audio.transcriptions.create({
//                 file: stream,
//                 model: "gpt-4o-mini-transcribe", // ou 'gpt-4o-transcribe' / 'whisper-1'
//                 language: "pt",
//             });

//             transcriptText = (result?.text || "").trim();
//             res.json({ text: transcriptText });
//         } finally {
//             // sempre tentar limpar o arquivo temporário
//             fs.unlink(tmpPath, () => {});
//             done({
//                 file: { name: originalname, type: mimetype, size },
//                 text_len: transcriptText.length,
//             });
//         }
//     })
// );

app.post("/transcribe", upload.single("audio"), async (req, res) => {
    const rid = Math.random().toString(36).slice(2, 8);
    try {
        if (!req.file) {
            res.status(400).json({ error: "no_file" });
            return;
        }

        const { originalname, mimetype, size, path: tmpPath } = req.file;
        console.log(
            `[transcribe] [${rid}] file name="${originalname}" type=${mimetype} size=${size}B tmp=${tmpPath}`
        );

        // 👇 Passe o stream com NOME e TYPE corretos
        const uploadable = await toFile(
            fs.createReadStream(tmpPath),
            "audio.m4a", // 👈 garante extensão boa
            { type: "audio/m4a" } // 👈 garante mimetype correto
        );

        const result = await openai.audio.transcriptions.create({
            file: uploadable,
            model: "gpt-4o-transcribe", // ou 'gpt-4o-transcribe' / 'whisper-1'
            language: "pt",
        });

        const text = (result?.text || "").trim();
        console.log(`[transcribe] [${rid}] OK text_len=${text.length}`);
        res.json({ text });
    } catch (err) {
        console.error(`[transcribe] [${rid}] ERROR`, err);
        res.status(500).json({ error: "transcription_failed" });
    } finally {
        // sempre limpe o tmp do multer
        if (req.file?.path) fs.unlink(req.file.path, () => {});
    }
});

// ====== /chat (texto) ======
app.post(
    "/chat",
    withTiming("chat", async (req, res, done) => {
        const messages = Array.isArray(req.body?.messages)
            ? req.body.messages
            : [];
        const preview = (
            messages[messages.length - 1]?.text ||
            messages[messages.length - 1]?.content ||
            ""
        ).slice(0, 120);

        console.log(
            `[chat] messages_len=${messages.length} last="${preview.replace(
                /\s+/g,
                " "
            )}"`
        );

        const persona = `
            Você é "Elis", uma personagem cordial, curiosa e prestativa.
            Estilo: leve, natural, brasileira (pt-BR), nordestina, respostas curtas a médias.
            Evite termos do português de Portugal.
            Se o usuário pedir algo técnico, responda de forma clara e objetiva.
            `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: persona },
                ...messages.map((m) => ({
                    role: m.role || "user",
                    content: m.text ?? m.content ?? "",
                })),
            ],
            temperature: 0.5,
        });

        const text = completion.choices?.[0]?.message?.content?.trim() || "";
        res.json({ text });
        done({ reply_len: text.length });
    })
);

// ====== /tts (síntese de fala) ======
app.post(
    "/tts",
    withTiming("tts", async (req, res, done) => {
        const { text, voice = "marin", format = "mp3" } = req.body || {};
        if (!text || !String(text).trim()) {
            res.status(400).json({ error: "no_text" });
            return done({ error: "no_text" });
        }
        console.log(
            `[tts] voice=${voice} format=${format} text_preview="${String(text)
                .slice(0, 80)
                .replace(/\s+/g, " ")}"`
        );

        const speech = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice,
            input: text,
            format, // 'mp3' | 'wav' | 'opus'
        });

        const buffer = Buffer.from(await speech.arrayBuffer());
        res.setHeader("Content-Type", `audio/${format}`);
        res.setHeader("Content-Length", buffer.length);
        res.send(buffer);
        done({ bytes: buffer.length, voice, format });
    })
);

// ====== ERROR HANDLER (fallback) ======
app.use((err, req, res, next) => {
    console.error("[unhandled]", err);
    res.status(500).json({ error: "internal_error" });
});

// ====== START ======
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0"; // importante p/ emulador
app.listen(PORT, HOST, () => {
    console.log(`[boot] API up on http://${HOST}:${PORT}`);
});
