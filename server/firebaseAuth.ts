import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  isAdmin: boolean;
}

export interface AuthenticatedRequest extends Request {
  firebaseUser?: VerifiedFirebaseUser;
}

const ADMIN_EMAILS = new Set([
  "aasiyahadiya7575@gmail.com",
  "salmatasneem75@gmail.com",
  "salmatasneem692@gmail.com",
]);

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedProjectId: string | null = null;
let cachedDatabaseId: string | null = null;
let cachedCerts: Record<string, string> = {};
let certsExpireAtMs = 0;

type CustomTokenVerifier = (token: string) => Promise<VerifiedFirebaseUser | null>;
let customVerifierForTests: CustomTokenVerifier | null = null;

export function setTestTokenVerifier(verifier: CustomTokenVerifier | null): void {
  customVerifierForTests = verifier;
}

export function getFirebaseProjectId(): string {
  if (cachedProjectId) return cachedProjectId;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cfgPath = path.resolve(__dirname, "../firebase-applet-config.json");
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as { projectId?: string; firestoreDatabaseId?: string };
    if (parsed.firestoreDatabaseId && typeof parsed.firestoreDatabaseId === "string") {
      cachedDatabaseId = parsed.firestoreDatabaseId;
    }
    if (parsed.projectId && typeof parsed.projectId === "string") {
      cachedProjectId = parsed.projectId;
      return cachedProjectId;
    }
  } catch {
    // Fallback to env var if config file unavailable
  }
  const envProj = process.env.FIREBASE_PROJECT_ID?.trim() || "arcane-bay-qsmzh";
  cachedProjectId = envProj;
  return envProj;
}

export function getFirebaseServerSummary() {
  const projectId = getFirebaseProjectId();
  return {
    configured: Boolean(projectId && projectId !== "remixed-project-id"),
    projectId,
    databaseId: cachedDatabaseId || "(default)",
  };
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const jsonStr = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(jsonStr) as T;
}

async function fetchGooglePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (Object.keys(cachedCerts).length > 0 && now < certsExpireAtMs) {
    return cachedCerts;
  }

  const res = await fetch(CERT_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public certificates (HTTP ${res.status}).`);
  }
  const certs = (await res.json()) as Record<string, string>;
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) : 3600;
  cachedCerts = certs;
  certsExpireAtMs = now + maxAgeSec * 1000;
  return certs;
}

export function isAdminEmail(email: string | null | undefined, emailVerified: boolean): boolean {
  if (!email || !emailVerified) return false;
  return ADMIN_EMAILS.has(email.toLowerCase().trim());
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser | null> {
  if (customVerifierForTests) {
    return customVerifierForTests(idToken);
  }

  const trimmed = idToken.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  try {
    header = decodeBase64UrlJson(headerB64);
    payload = decodeBase64UrlJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) {
    return null;
  }

  const projectId = getFirebaseProjectId();
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.aud !== projectId || payload.iss !== expectedIssuer) {
    return null;
  }
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length > 128) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec - 30) {
    return null;
  }
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 300) {
    return null;
  }

  let certs = await fetchGooglePublicCerts();
  let certPem = certs[header.kid];
  if (!certPem) {
    // Force refresh once in case of key rotation
    certsExpireAtMs = 0;
    certs = await fetchGooglePublicCerts();
    certPem = certs[header.kid];
    if (!certPem) return null;
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const validSig = crypto.verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), certPem, sigBuf);
  if (!validSig) {
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const emailVerified = payload.email_verified === true;

  return {
    uid: payload.sub,
    email,
    emailVerified,
    displayName: typeof payload.name === "string" ? payload.name : null,
    isAdmin: isAdminEmail(email, emailVerified),
  };
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.header("authorization") || req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

export async function requireAuthenticatedFirebaseUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({
        error: "Authentication required. Please sign in with your AROVA account.",
      });
      return;
    }

    const user = await verifyFirebaseIdToken(token);
    if (!user) {
      res.status(401).json({
        error: "Invalid or expired Firebase authentication token.",
      });
      return;
    }

    req.firebaseUser = user;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : "Authentication verification failed.",
    });
  }
}

export async function requireVerifiedFirebaseUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({
        error: "Authentication required. Sign in with a verified account to access Arova voice records and caregiver contacts.",
      });
      return;
    }

    const user = await verifyFirebaseIdToken(token);
    if (!user) {
      res.status(401).json({
        error: "Invalid or expired Firebase authentication token.",
      });
      return;
    }

    if (!user.emailVerified) {
      res.status(403).json({
        error: "Email verification is required for caregiver and voice operations.",
      });
      return;
    }

    req.firebaseUser = user;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : "Authentication verification failed.",
    });
  }
}

export async function requireAdminFirebaseUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await requireVerifiedFirebaseUser(req, res, () => {
    if (!req.firebaseUser?.isAdmin) {
      res.status(403).json({
        error: "Administrator authorization required for this Arova AI voice control action.",
      });
      return;
    }
    next();
  });
}
