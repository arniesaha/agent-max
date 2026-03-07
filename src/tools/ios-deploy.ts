import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

const DEFAULT_DEVICE_ID = process.env.IOS_DEVICE_ID || "";
const NIXCLAW_PROJECT = path.join(process.env.HOME!, "max", "projects", "NixClaw");

// Full paths to avoid PATH issues in LaunchAgent context
const XCODEBUILD = "/usr/bin/xcodebuild";
const XCRUN = "/usr/bin/xcrun";

export const iosListDevices: AgentTool = {
  name: "ios_list_devices",
  label: "List iOS Devices",
  description: "List paired iOS devices available for deployment via xcrun devicectl",
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const { stdout } = await execFileAsync(XCRUN, ["devicectl", "list", "devices"], { timeout: 15000 });
      return { content: [{ type: "text", text: stdout }], details: { success: true } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to list devices: ${e.message}\n${e.stderr || ""}` }], details: { success: false } };
    }
  },
};

export const iosBuild: AgentTool = {
  name: "ios_build",
  label: "Build iOS App",
  description: "Build an iOS Xcode project. Defaults to NixClaw project. Handles provisioning and code signing automatically.",
  parameters: Type.Object({
    project_path: Type.Optional(Type.String({ description: "Path to .xcodeproj. Defaults to ~/max/projects/NixClaw/NixClaw.xcodeproj" })),
    scheme: Type.Optional(Type.String({ description: "Build scheme. Defaults to NixClaw" })),
    configuration: Type.Optional(Type.String({ description: "Build configuration: Debug or Release. Defaults to Debug" })),
    device_id: Type.Optional(Type.String({ description: "Target device ID" })),
  }),
  execute: async (_id, params: any) => {
    const projectPath = params.project_path || path.join(NIXCLAW_PROJECT, "NixClaw.xcodeproj");
    const scheme = params.scheme || "NixClaw";
    const configuration = params.configuration || "Debug";
    const deviceId = params.device_id || DEFAULT_DEVICE_ID;
    const projectDir = path.dirname(projectPath);

    try {
      const args = [
        "-project", projectPath,
        "-scheme", scheme,
        "-configuration", configuration,
        `-destination`, `id=${deviceId}`,
        "-allowProvisioningUpdates",
        "clean", "build",
        "ONLY_ACTIVE_ARCH=YES",
      ];

      log("info", `ios_build: spawning ${XCODEBUILD}`, { args, cwd: projectDir });
      const { stdout, stderr } = await execFileAsync(XCODEBUILD, args, {
        timeout: 300000, // 5 min for builds
        cwd: projectDir,
      });

      const output = stdout + "\n" + stderr;
      const succeeded = output.includes("BUILD SUCCEEDED");
      const errors = output.split("\n").filter(l => l.includes("error:")).join("\n");
      const warnings = output.split("\n").filter(l => l.includes("warning:")).slice(0, 10).join("\n");

      const summary = succeeded
        ? `BUILD SUCCEEDED\n${warnings ? `\nWarnings:\n${warnings}` : ""}`
        : `BUILD FAILED\n\nErrors:\n${errors}\n${warnings ? `\nWarnings:\n${warnings}` : ""}`;

      return { content: [{ type: "text", text: summary }], details: { success: succeeded, scheme, configuration } };
    } catch (e: any) {
      const output = (e.stdout || "") + "\n" + (e.stderr || "");
      const errors = output.split("\n").filter((l: string) => l.includes("error:")).slice(0, 20).join("\n");
      const detail = `code=${e.code} signal=${e.signal} killed=${e.killed} cmd=${XCODEBUILD} cwd=${projectDir}`;
      log("error", `ios_build failed: ${detail}`, { message: e.message, code: e.code });
      return {
        content: [{ type: "text", text: `Build failed (${detail}):\n${errors || e.message}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};

export const iosInstall: AgentTool = {
  name: "ios_install",
  label: "Install iOS App",
  description: "Install a built .app bundle onto a paired iOS device wirelessly via xcrun devicectl",
  parameters: Type.Object({
    device_id: Type.Optional(Type.String({ description: "Target device ID" })),
    app_path: Type.Optional(Type.String({ description: "Path to .app bundle. If omitted, finds the most recent build in DerivedData" })),
    scheme: Type.Optional(Type.String({ description: "Scheme name to find in DerivedData. Defaults to NixClaw" })),
  }),
  execute: async (_id, params: any) => {
    const deviceId = params.device_id || DEFAULT_DEVICE_ID;
    let appPath = params.app_path;

    if (!appPath) {
      // Find the most recent .app in DerivedData
      const scheme = params.scheme || "NixClaw";
      try {
        const { stdout } = await execFileAsync("bash", ["-c",
          `find ~/Library/Developer/Xcode/DerivedData/${scheme}-*/Build/Products/Debug-iphoneos -name '*.app' -maxdepth 1 2>/dev/null | head -1`
        ], { timeout: 10000 });
        appPath = stdout.trim();
      } catch {
        // Try broader search
        try {
          const { stdout } = await execFileAsync("bash", ["-c",
            `find ~/Library/Developer/Xcode/DerivedData -path "*/Debug-iphoneos/${scheme}.app" 2>/dev/null | head -1`
          ], { timeout: 10000 });
          appPath = stdout.trim();
        } catch { /* fall through */ }
      }

      if (!appPath) {
        return {
          content: [{ type: "text", text: "Could not find .app bundle in DerivedData. Build the project first, or provide app_path explicitly." }],
          details: { success: false },
        };
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(XCRUN, [
        "devicectl", "device", "install", "app",
        "--device", deviceId,
        appPath,
      ], { timeout: 120000 });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: `App installed successfully.\n${output}` }], details: { success: true, appPath } };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Install failed: ${e.message}\n${e.stderr || ""}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};

export const iosBuildAndDeploy: AgentTool = {
  name: "ios_build_and_deploy",
  label: "Build & Deploy iOS App",
  description: "Build and wirelessly deploy an iOS app to a paired iPhone in one step. Defaults to NixClaw project.",
  parameters: Type.Object({
    project_path: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
    scheme: Type.Optional(Type.String({ description: "Build scheme" })),
    configuration: Type.Optional(Type.String({ description: "Debug or Release" })),
    device_id: Type.Optional(Type.String({ description: "Target device ID" })),
  }),
  execute: async (_id, params: any) => {
    // Build
    const buildResult = await iosBuild.execute("build", params);
    if (!buildResult.details?.success) {
      return buildResult;
    }

    // Install
    const installResult = await iosInstall.execute("install", {
      device_id: params.device_id,
      scheme: params.scheme || "NixClaw",
    });

    const buildText = (buildResult.content[0] as any).text || "";
    const installText = (installResult.content[0] as any).text || "";

    if (installResult.details?.success) {
      const text = `Build & deploy succeeded.\n\n${buildText}\n\n${installText}`;
      return { content: [{ type: "text", text }], details: { success: true } };
    } else {
      const text = `Build succeeded but install failed.\n\n${installText}`;
      return { content: [{ type: "text", text }], details: { success: false } };
    }
  },
};
