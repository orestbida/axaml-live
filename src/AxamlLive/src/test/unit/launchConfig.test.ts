import * as assert from "assert";
import * as path from "path";
import { projectFromLaunchConfigurations } from "../../services/launchConfig";

const root = path.resolve("/work/app");
const projects = [
    {
        name: "App.Desktop",
        path: path.join(root, "App.Desktop", "App.Desktop.csproj"),
        targetPath: path.join(root, "App.Desktop", "bin", "Debug", "net10.0", "App.Desktop.dll"),
    },
    {
        name: "App.Tool",
        path: path.join(root, "App.Tool", "App.Tool.csproj"),
        targetPath: path.join(root, "App.Tool", "bin", "Debug", "net10.0", "App.Tool.dll"),
    },
];

suite("launch configuration -> previewer host", () => {
    test("coreclr program with ${workspaceFolder}", () => {
        const configs = [{ type: "coreclr", request: "launch", program: "${workspaceFolder}/App.Tool/bin/Debug/net10.0/App.Tool.dll" }];
        assert.strictEqual(projectFromLaunchConfigurations(configs, projects, root)?.name, "App.Tool");
    });

    test("C# Dev Kit 'dotnet' configuration with projectPath", () => {
        const configs = [{ type: "dotnet", request: "launch", projectPath: "${workspaceFolder}/App.Desktop/App.Desktop.csproj" }];
        assert.strictEqual(projectFromLaunchConfigurations(configs, projects, root)?.name, "App.Desktop");
    });

    test("program matched by assembly name when the path differs (other configuration/TFM)", () => {
        const configs = [{ type: "coreclr", program: "${workspaceFolder}/App.Tool/bin/Release/net9.0/App.Tool.dll" }];
        assert.strictEqual(projectFromLaunchConfigurations(configs, projects, root)?.name, "App.Tool");
    });

    test("first matching configuration wins; unrelated configurations are skipped", () => {
        const configs = [
            { type: "node", program: "x.js" },
            { type: "coreclr", program: "${workspaceFolder}/App.Desktop/bin/Debug/net10.0/App.Desktop.dll" },
        ];
        assert.strictEqual(projectFromLaunchConfigurations(configs, projects, root)?.name, "App.Desktop");
        assert.strictEqual(projectFromLaunchConfigurations([{ type: "node" }], projects, root), undefined);
    });
});
