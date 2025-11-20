// index.js – Stabiler Express-Server für Vercel (MVP ohne Thirdweb/Replicate/Neynar)

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import { uploadImageToIpfs, uploadMetadataToIpfs } from "./ipfs_uploader.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------
// In-Memory Cache für Jobs
// ----------------------------------------------------
const MINT_CACHE = {}; // { [fid]: { status, ipfsUri, metadataUri, message? } }

// ----------------------------------------------------
// CORS
// ----------------------------------------------------
const allowedOrigins = [
  "https://farcaster-box-frontend.vercel.app",
  "https://farcaster-box-frame.vercel.app",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn("[CORS] Blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// MOCK-KI: Platzhalterbild anhand FID
// ----------------------------------------------------
async function generateBoxCharacter(fid) {
  const seed = String(fid || "default");
  const url = `https://picsum.photos/seed/${encodeURIComponent(
    seed
  )}/1024/1024`;
  console.log("[MOCK KI] Nutze Platzhalterbild:", url);
  return url;
}

// ----------------------------------------------------
// POST /api/start-generation
// ----------------------------------------------------
app.post("/api/start-generation", async (req, res) => {
  const { fid } = req.body || {};

  if (!fid) {
    console.warn("[START-GENERATION] Missing FID im Body");
    return res.status(400).json({ error: "Missing FID" });
  }

  console.log("[START-GENERATION] Starte Job für FID:", fid);

  // Wenn bereits fertig, direkt zurückgeben
  if (MINT_CACHE[fid] && MINT_CACHE[fid].status === "ready") {
    console.log("[START-GENERATION] FID bereits ready, sende cached Ergebnis.");
    return res.json({
      status: "ready",
      ipfsUri: MINT_CACHE[fid].ipfsUri,
      metadataUri: MINT_CACHE[fid].metadataUri,
    });
  }

  // Status auf "processing" setzen
  MINT_CACHE[fid] = { status: "processing" };

  // Sofortige Antwort an Frontend
  res.json({
    status: "processing",
    message: "Generation started.",
  });

  // Hintergrund-Job: Bild + IPFS
  try {
    // 1. Platzhalterbild holen
    const imageUrl = await generateBoxCharacter(fid);

    // 2. Bild zu IPFS (Pinata)
    const ipfsImageUri = await uploadImageToIpfs(imageUrl, fid);
    if (!ipfsImageUri) throw new Error("IPFS image upload failed.");

    // 3. Metadata zu IPFS (Pinata)
    const metadataUri = await uploadMetadataToIpfs(fid, ipfsImageUri);
    if (!metadataUri) throw new Error("IPFS metadata upload failed.");

    // 4. Cache updaten
    MINT_CACHE[fid] = {
      status: "ready",
      ipfsUri: ipfsImageUri,
      metadataUri,
    };

    console.log(
      "[GENERATION READY] FID:",
      fid,
      "Bild:",
      ipfsImageUri,
      "Metadata:",
      metadataUri
    );
  } catch (err) {
    console.error("[GENERATION ERROR] FID:", fid, err);
    MINT_CACHE[fid] = {
      status: "error",
      message: err.message || "Unknown error",
    };
  }
});

// ----------------------------------------------------
// GET /api/status?fid=...
// ----------------------------------------------------
app.get("/api/status", (req, res) => {
  const { fid } = req.query || {};

  if (!fid || !MINT_CACHE[fid]) {
    return res.status(404).json({ error: "No active job." });
  }

  return res.json(MINT_CACHE[fid]);
});

// ----------------------------------------------------
// POST /api/mint-nft  (MOCK-MINT nur für UI-Flow)
// ----------------------------------------------------
app.post("/api/mint-nft", async (req, res) => {
  try {
    console.log("[MOCK MINT] Anfrage erhalten, Body:", req.body);

    const { fid, recipientAddress } = req.body || {};

    if (!fid || !recipientAddress) {
      console.warn("[MOCK MINT] Missing parameters:", { fid, recipientAddress });
      return res.status(400).json({
        success: false,
        error: "Missing parameters (fid oder recipientAddress).",
      });
    }

    const entry = MINT_CACHE[fid];

    if (!entry || entry.status !== "ready") {
      console.warn(
        "[MOCK MINT] Not ready to mint für FID:",
        fid,
        "Entry:",
        entry
      );
      return res.status(409).json({
        success: false,
        error: "Not ready to mint – kein 'ready'-Status im Cache.",
      });
    }

    // Fake Tx Hash generieren (nur fürs UI)
    const fakeTxHash = "0x" + crypto.randomBytes(32).toString("hex");
    console.log("[MOCK MINT] Erfolgreich, Fake TxHash:", fakeTxHash);

    // Cache leeren
    delete MINT_CACHE[fid];

    return res.json({
      success: true,
      txHash: fakeTxHash,
    });
  } catch (err) {
    console.error("[MOCK MINT ERROR]", err);
    return res.status(500).json({
      success: false,
      error: "Mock mint failed.",
      details: err.message || String(err),
    });
  }
});

// ----------------------------------------------------
// Export für Vercel
// ----------------------------------------------------
export default app;

// Optional lokal:
if (process.env.NODE_ENV === "development") {
  app.listen(PORT, () => {
    console.log(`Dev-Server läuft auf http://localhost:${PORT}`);
  });
}
