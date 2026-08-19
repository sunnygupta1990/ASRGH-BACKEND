import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { config as loadEnvironment } from "dotenv";
import sharp from "sharp";

const IMAGE_DIRECTORY = "C:\\Users\\Lenovo\\Downloads\\Members Images\\Members Images";
const FRONTEND_DIRECTORY = path.resolve(__dirname, "../ASRGH_V2_NODE");
const REPORT_FILENAME = "member-photo-upload-report.csv";
const CONCURRENCY = 5;
const MEMBER_PAGE_SIZE = 200;
const PROFILE_PHOTO_SIZE = 512;
const SUPPORTED_EXTENSIONS = new Set([".jfif", ".jpg", ".jpeg", ".png", ".webp"]);
const DRY_RUN = process.argv.includes("--dry-run");

type Status = "uploaded" | "not-found" | "failed" | "skipped";

interface Member {
  id: string;
  memberCode: string | null;
  profileMediaId?: string | null;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  token?: string;
  user?: {
    isSystemRole?: boolean;
    roles?: Array<{ name: string; isSystemRole: boolean }>;
  };
  pagination?: { page: number; totalPages: number };
}

interface ResultRow {
  filename: string;
  memberCode: string;
  status: Status;
  message: string;
  matched: boolean;
}

function loadExistingApiConfiguration(): string {
  for (const filename of [".env", ".env.production"]) {
    loadEnvironment({ path: path.join(FRONTEND_DIRECTORY, filename), override: false, quiet: true });
  }

  const configuredUrl = process.env.VITE_API_BASE_URL?.trim();
  if (!configuredUrl) {
    throw new Error("VITE_API_BASE_URL is missing from the existing frontend environment configuration.");
  }
  return configuredUrl.replace(/\/$/, "");
}

function normalizeCode(input: string): string {
  return input.trim().toLocaleUpperCase("en-US");
}

function memberCodeFromFilename(filename: string): string | null {
  const extension = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  const nameWithoutExtension = filename.slice(0, -extension.length).trim();
  const match = nameWithoutExtension.match(/(?:^|[^a-z0-9])([lt])-\s*(\d+)([a-z]?)(?=$|[^a-z0-9])/i);
  if (!match) return null;
  return normalizeCode(`${match[1]}-${match[2]}${match[3]}`);
}

async function promptForCredentials(): Promise<{ identifier: string; password: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal to enter Super Admin credentials.");
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const identifier = (await prompt.question("Super Admin email or employee ID: ")).trim();
  prompt.close();

  process.stdout.write("Super Admin password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let password = "";

  try {
    passwordInput: for await (const chunk of process.stdin) {
      for (const input of String(chunk)) {
        if (input === "\r" || input === "\n") break passwordInput;
        if (input === "\u0003") throw new Error("Cancelled.");
        if (input === "\u007f" || input === "\b") {
          password = password.slice(0, -1);
        } else {
          password += input;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }

  if (!identifier || !password) throw new Error("Super Admin identifier and password are required.");
  return { identifier, password };
}

async function request<T>(apiBaseUrl: string, endpoint: string, token: string | undefined, options: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");

  const response = await fetch(`${apiBaseUrl}${endpoint}`, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json() as ApiEnvelope<T>
    : { success: false, message: (await response.text()).slice(0, 300) };

  if (!response.ok || !body.success) {
    throw new Error(body.message ?? `API request failed with HTTP ${response.status}`);
  }
  return body;
}

async function login(apiBaseUrl: string): Promise<string> {
  const credentials = await promptForCredentials();
  const response = await request<never>(apiBaseUrl, "/api/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  const isSuperAdmin = response.user?.isSystemRole || response.user?.roles?.some((role) => role.isSystemRole);
  if (!isSuperAdmin) throw new Error("The authenticated account is not a Super Admin.");
  if (!response.token) throw new Error("Login succeeded without an authentication token.");
  return response.token;
}

async function fetchMembers(apiBaseUrl: string, token: string): Promise<Member[]> {
  const members: Member[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request<Member[]>(apiBaseUrl, `/api/members?page=${page}&pageSize=${MEMBER_PAGE_SIZE}`, token);
    members.push(...(response.data ?? []));
    if (page >= (response.pagination?.totalPages ?? 1)) return members;
  }
}

async function imageFiles(): Promise<string[]> {
  const entries = await fs.readdir(IMAGE_DIRECTORY, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(IMAGE_DIRECTORY, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

async function upload(apiBaseUrl: string, token: string, memberId: string, filePath: string): Promise<void> {
  const webp = await sharp(filePath)
    .resize(PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 85 })
    .toBuffer();
  const form = new FormData();
  form.append("profilePhoto", new Blob([webp], { type: "image/webp" }), `${path.parse(filePath).name}.webp`);
  await request(apiBaseUrl, `/api/members/${memberId}/profile-photo`, token, { method: "POST", body: form });
}

async function processFile(apiBaseUrl: string, token: string, filePath: string, members: Map<string, Member>, selectedFiles: Map<string, string>): Promise<ResultRow> {
  const filename = path.basename(filePath);
  const memberCode = memberCodeFromFilename(filename);
  if (!memberCode) return { filename, memberCode: "", status: "skipped", message: "No recognizable L-/T- member code in filename.", matched: false };
  const member = members.get(memberCode);
  if (!member) return { filename, memberCode, status: "not-found", message: "No member with this member code exists.", matched: false };
  const selectedFilename = selectedFiles.get(memberCode);
  if (selectedFilename !== filename) return { filename, memberCode, status: "skipped", message: `Duplicate member code; selected ${selectedFilename}.`, matched: false };
  if (DRY_RUN) {
    console.log(`MATCH ${filename} -> ${memberCode} -> member ${member.id}`);
    return { filename, memberCode, status: "skipped", message: `Dry run: would upload to member ${member.id}.`, matched: true };
  }

  try {
    await upload(apiBaseUrl, token, member.id, filePath);
    return { filename, memberCode, status: "uploaded", message: "Profile photo uploaded successfully.", matched: true };
  } catch (error) {
    return { filename, memberCode, status: "failed", message: error instanceof Error ? error.message : "Unknown upload error.", matched: true };
  }
}

function counts(results: ResultRow[]): Record<Status, number> {
  return results.reduce<Record<Status, number>>((total, row) => {
    total[row.status] += 1;
    return total;
  }, { uploaded: 0, "not-found": 0, failed: 0, skipped: 0 });
}

async function processAll(apiBaseUrl: string, token: string, files: string[], members: Map<string, Member>): Promise<ResultRow[]> {
  const results: ResultRow[] = [];
  const selectedFiles = new Map<string, string>();
  for (const filePath of files) {
    const memberCode = memberCodeFromFilename(path.basename(filePath));
    if (memberCode && members.has(memberCode) && !selectedFiles.has(memberCode)) {
      selectedFiles.set(memberCode, path.basename(filePath));
    }
  }
  for (let index = 0; index < files.length; index += CONCURRENCY) {
    const group = files.slice(index, index + CONCURRENCY);
    results.push(...await Promise.all(group.map((file) => processFile(apiBaseUrl, token, file, members, selectedFiles))));
    const total = counts(results);
    console.log(`[${results.length}/${files.length}] uploaded=${total.uploaded} failed=${total.failed} not-found=${total["not-found"]} skipped=${total.skipped}`);
  }
  return results;
}

async function writeReport(results: ResultRow[]): Promise<string> {
  const escape = (input: string) => `"${input.replaceAll('"', '""')}"`;
  const lines = ["filename,memberCode,status,message", ...results.map((row) => [row.filename, row.memberCode, row.status, row.message].map(escape).join(","))];
  const reportPath = path.resolve(process.cwd(), REPORT_FILENAME);
  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  const apiBaseUrl = loadExistingApiConfiguration();
  console.log(`Member photo batch upload${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`Image directory: ${IMAGE_DIRECTORY}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  const token = await login(apiBaseUrl);
  const [files, memberList] = await Promise.all([imageFiles(), fetchMembers(apiBaseUrl, token)]);
  const members = new Map(memberList.flatMap((member) => member.memberCode ? [[normalizeCode(member.memberCode), member] as const] : []));
  console.log(`Found ${files.length} supported images and loaded ${members.size} coded members.`);

  const results = await processAll(apiBaseUrl, token, files, members);
  const reportPath = await writeReport(results);
  const total = counts(results);
  const matched = results.filter((result) => result.matched).length;
  const skipped = results.filter((result) => result.status === "skipped" && !result.matched).length;
  console.log("\nFinal summary");
  console.log(`matched=${matched}`);
  console.log(`not-found=${total["not-found"]}`);
  console.log(`skipped=${skipped}`);
  console.log(`total=${results.length}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(`Batch upload failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
