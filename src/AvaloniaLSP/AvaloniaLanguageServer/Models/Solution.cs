using System.Text.Json.Serialization;
namespace AvaloniaLanguageServer.Models {
    public partial class SolutionData {
        [JsonPropertyName("solution")]
        public string Solution { get; set; } = "";

        [JsonPropertyName("projects")]
        public Project[] Projects { get; set; } = Array.Empty<Project>();

        [JsonPropertyName("files")]
        public ProjectFile[] Files { get; set; } = Array.Empty<ProjectFile>();

        /// <summary>
        /// Assemblies to load completion metadata from, best first, for a file of the given project:
        /// the project itself if executable, executables referencing it, the project itself (class library, #169), any executable.
        /// </summary>
        public IEnumerable<Project> GetCompletionTargets(string? projectPath) {
            static bool Same(string? a, string? b) =>
                a != null && b != null && string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
            static bool IsExe(Project p) => p.OutputType is "WinExe" or "Exe";

            var own = Projects.FirstOrDefault(p => Same(p.Path, projectPath));
            if (own != null) {
                if (IsExe(own)) {
                    yield return own;
                }

                foreach (var exe in Projects.Where(p => IsExe(p) && (p.ProjectReferences ?? Array.Empty<string>()).Any(r => Same(r, own.Path)))
                             .OrderByDescending(p => !string.IsNullOrEmpty(p.DesignerHostPath))
                             .ThenByDescending(p => p.Name.Contains("Desktop", StringComparison.OrdinalIgnoreCase))) {
                    yield return exe;
                }

                yield return own;
            }
            if (GetExecutableProject() is { } fallback) {
                yield return fallback;
            }
        }

        public Project? GetExecutableProject() {
            var exes = Projects.Where(p => p.OutputType is "WinExe" or "Exe").ToList();
            return exes.FirstOrDefault(p => !string.IsNullOrEmpty(p.DesignerHostPath) && p.Name.Contains("Desktop", StringComparison.OrdinalIgnoreCase))
                ?? exes.FirstOrDefault(p => !string.IsNullOrEmpty(p.DesignerHostPath))
                ?? exes.FirstOrDefault();
        }
    }

    public partial class ProjectFile {
        [JsonPropertyName("path")]
        public string Path { get; set; } = "";

        [JsonPropertyName("targetPath")]
        public string TargetPath { get; set; } = "";

        [JsonPropertyName("projectPath")]
        public string ProjectPath { get; set; } = "";
    }

    public partial class Project {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("path")]
        public string Path { get; set; } = "";

        [JsonPropertyName("targetPath")]
        public string TargetPath { get; set; } = "";

        [JsonPropertyName("outputType")]
        public string OutputType { get; set; } = "";

        [JsonPropertyName("designerHostPath")]
        public string DesignerHostPath { get; set; } = "";

        [JsonPropertyName("targetFramework")]
        public string TargetFramework { get; set; } = "";

        [JsonPropertyName("depsFilePath")]
        public string DepsFilePath { get; set; } = "";

        [JsonPropertyName("runtimeConfigFilePath")]
        public string RuntimeConfigFilePath { get; set; } = "";

        [JsonPropertyName("projectReferences")]
        public string[] ProjectReferences { get; set; } = Array.Empty<string>();

        [JsonPropertyName("directoryPath")]
        public string DirectoryPath { get; set; } = "";


        [JsonPropertyName("intermediateOutputPath")]
        public string IntermediateOutputPath { get; set; } = "";
    }

}
