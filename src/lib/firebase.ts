import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { doc, getDocFromServer, getFirestore } from "firebase/firestore";
import appletFirebaseConfig from "../../firebase-applet-config.json";

const env = import.meta.env as Record<string, string | undefined>;

const resolvedConfig: FirebaseOptions & { firestoreDatabaseId?: string } = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim() || appletFirebaseConfig.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || appletFirebaseConfig.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() || appletFirebaseConfig.projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || appletFirebaseConfig.storageBucket,
  messagingSenderId:
    env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || appletFirebaseConfig.messagingSenderId,
  appId: env.VITE_FIREBASE_APP_ID?.trim() || appletFirebaseConfig.appId,
  firestoreDatabaseId:
    env.VITE_FIREBASE_DATABASE_ID?.trim() || appletFirebaseConfig.firestoreDatabaseId,
};

export const firebaseConfigStatus = {
  configured: Boolean(
    resolvedConfig.apiKey &&
      resolvedConfig.projectId &&
      resolvedConfig.appId &&
      resolvedConfig.projectId !== "remixed-project-id"
  ),
  projectId: resolvedConfig.projectId || "",
  firestoreDatabaseId: resolvedConfig.firestoreDatabaseId || "(default)",
  authDomain: resolvedConfig.authDomain || "",
};

const app = initializeApp(resolvedConfig);
export const db = resolvedConfig.firestoreDatabaseId
  ? getFirestore(app, resolvedConfig.firestoreDatabaseId)
  : getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Explicitly enforce browser local session persistence across reloads
void setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("Could not enforce browserLocalPersistence:", err);
});

export const OperationType = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  LIST: "list",
  GET: "get",
  WRITE: "write",
} as const;

export type OperationTypeValue = (typeof OperationType)[keyof typeof OperationType];

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationTypeValue;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationTypeValue,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error:", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  if (!firebaseConfigStatus.configured) {
    return false;
  }
  try {
    await getDocFromServer(doc(db, "test", "connection"));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("the client is offline") ||
        error.message.includes("Failed to get document because the client is offline"))
    ) {
      console.error("Please check your Firebase configuration.");
      return false;
    }
    return true;
  }
}
