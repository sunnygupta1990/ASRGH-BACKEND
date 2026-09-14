import * as objectstorage from "oci-objectstorage";
import common = require("oci-common");
import { Readable } from "stream";

const DEFAULT_NAMESPACE = "bmkciozwmkcv";
const DEFAULT_BUCKET = "asrgh-media";

export interface OracleStoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  eTag?: string;
  lastModified?: Date;
}

let clientPromise: Promise<objectstorage.ObjectStorageClient> | null = null;

function namespaceName(): string {
  return process.env.OCI_OBJECT_STORAGE_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
}

function bucketName(): string {
  return process.env.OCI_OBJECT_STORAGE_BUCKET?.trim() || DEFAULT_BUCKET;
}

async function getClient(): Promise<objectstorage.ObjectStorageClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const authenticationDetailsProvider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
      return new objectstorage.ObjectStorageClient({
        authenticationDetailsProvider,
      });
    })();
  }

  return clientPromise;
}

export function objectNameFromStorageKey(storageKey: string): string | null {
  if (!storageKey.startsWith("/media/")) {
    return null;
  }

  const objectName = storageKey.replace(/^\/media\//, "").replace(/^\/+/, "");
  return objectName || null;
}

export function storageKeyFromObjectName(objectName: string): string {
  return `/media/${objectName.replace(/^\/+/, "")}`;
}

export function isOracleObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    statusCode?: number;
    serviceCode?: string;
    code?: string;
  };

  return (
    candidate.statusCode === 404 ||
    candidate.serviceCode === "ObjectNotFound" ||
    candidate.code === "ObjectNotFound"
  );
}

export async function putOracleObject(
  objectName: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const client = await getClient();

  await client.putObject({
    namespaceName: namespaceName(),
    bucketName: bucketName(),
    objectName: objectName.replace(/^\/+/, ""),
    contentLength: body.length,
    contentType,
    putObjectBody: body,
  });
}

export async function getOracleObject(
  objectName: string,
): Promise<OracleStoredObject> {
  const client = await getClient();
  const response = await client.getObject({
    namespaceName: namespaceName(),
    bucketName: bucketName(),
    objectName: objectName.replace(/^\/+/, ""),
  });

  const body = response.value instanceof Readable
    ? response.value
    : Readable.fromWeb(response.value as any);

  return {
    body,
    contentType: response.contentType,
    contentLength: response.contentLength,
    eTag: response.eTag,
    lastModified: response.lastModified,
  };
}

export async function deleteOracleObject(objectName: string): Promise<void> {
  const client = await getClient();

  try {
    await client.deleteObject({
      namespaceName: namespaceName(),
      bucketName: bucketName(),
      objectName: objectName.replace(/^\/+/, ""),
    });
  } catch (error) {
    if (!isOracleObjectNotFound(error)) {
      throw error;
    }
  }
}

export async function deleteOracleObjectByStorageKey(storageKey: string): Promise<void> {
  const objectName = objectNameFromStorageKey(storageKey);
  if (objectName) {
    await deleteOracleObject(objectName);
  }
}
