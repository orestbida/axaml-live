using Serilog;
using System.Diagnostics;
using AvaloniaLanguageServer.Services;
using Microsoft.CodeAnalysis;
using Xunit;

namespace AvaloniaLanguageServer.Tests;

/// <summary>
/// Three real projects in a temp folder: App references Lib, Other is unrelated. Restored once for all tests; each test
/// gets its own copy of the sources.
/// </summary>
public sealed class ProjectsFixture : IDisposable {
    public string Template { get; } = Path.Combine(Path.GetTempPath(), "axaml-live-tests", Guid.NewGuid().ToString("N"));

    public ProjectsFixture() {
        // the server's log (load failures and so on) next to the test output
        Serilog.Log.Logger = new Serilog.LoggerConfiguration()
            .WriteTo.File(Path.Combine(AppContext.BaseDirectory, "server-tests.log"), shared: true)
            .CreateLogger();
        Write(Template, "Lib/Lib.csproj", Project(""));
        Write(Template, "Lib/Person.cs", "namespace Lib; public class Person { public string Name { get; set; } = \"\"; }");
        Write(Template, "App/App.csproj", Project(
            "<ItemGroup><ProjectReference Include=\"../Lib/Lib.csproj\" /><AdditionalFiles Include=\"**/*.axaml\" /></ItemGroup>"));
        Write(Template, "App/Main.cs", "namespace App; public class Main { public Lib.Person P = new(); }");
        Write(Template, "App/View.axaml", View("Red", "Save", "Button"));
        Write(Template, "Other/Other.csproj", Project(""));
        Write(Template, "Other/Thing.cs", "namespace Other; public class Thing { }");
        Run("dotnet", "restore App/App.csproj", Template);
        Run("dotnet", "restore Other/Other.csproj", Template);
    }

    public static string Project(string items) =>
        $"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup>{items}</Project>";

    public static string View(string background, string name, string type) =>
        $"<UserControl xmlns=\"https://github.com/avaloniaui\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" x:Class=\"App.View\" Background=\"{background}\"><{type} x:Name=\"{name}\" /></UserControl>";

    public static void Write(string root, string relative, string text) {
        var path = Path.Combine(root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }

    /// <summary>A fresh copy of the restored projects (obj included, so no restore per test).</summary>
    public string Copy() {
        var root = Path.Combine(Path.GetTempPath(), "axaml-live-tests", Guid.NewGuid().ToString("N"));
        foreach (var file in Directory.EnumerateFiles(Template, "*", SearchOption.AllDirectories)) {
            var target = Path.Combine(root, Path.GetRelativePath(Template, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            // project.assets.json holds absolute paths of the template: rewrite them for the copy
            var text = File.ReadAllText(file);
            File.WriteAllText(target, text.Replace(Template, root).Replace(Template.Replace("\\", "\\\\"), root.Replace("\\", "\\\\")));
        }
        return root;
    }

    static void Run(string file, string args, string cwd) {
        var p = Process.Start(new ProcessStartInfo(file, args) { WorkingDirectory = cwd, RedirectStandardOutput = true, RedirectStandardError = true })!;
        p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) {
            throw new Exception($"{file} {args} failed: {p.StandardError.ReadToEnd()}");
        }
    }

    public void Dispose() {
        try {
            Directory.Delete(Path.GetDirectoryName(Template)!, recursive: true);
        } catch (IOException) {
            // a build host may still hold a file
        }
    }
}

public sealed class RoslynProjectsTests : IClassFixture<ProjectsFixture>, IDisposable {
    readonly string _root;
    readonly RoslynProjects _projects = new();

    public RoslynProjectsTests(ProjectsFixture fixture) {
        _root = fixture.Copy();
    }

    string P(string relative) => Path.Combine(_root, relative);

    async Task ChangeAsync(string relative, string text) {
        File.WriteAllText(P(relative), text);
        await _projects.FileChangedAsync(P(relative), deleted: false);
    }

    static async Task<bool> HasMemberAsync(Project project, string type, string member) {
        var compilation = await project.GetCompilationAsync();
        return compilation?.GetTypeByMetadataName(type)?.GetMembers(member).Any() == true;
    }

    [Fact]
    public async Task A_change_is_in_the_next_snapshot() {
        Assert.False(await HasMemberAsync((await _projects.GetProjectAsync(P("Lib/Lib.csproj")))!, "Lib.Person", "Age"));
        await ChangeAsync("Lib/Person.cs", "namespace Lib; public class Person { public string Name { get; set; } = \"\"; public int Age { get; set; } }");
        Assert.True(await HasMemberAsync((await _projects.GetProjectAsync(P("Lib/Lib.csproj")))!, "Lib.Person", "Age"));
    }

    [Fact]
    public async Task Changes_are_kept_when_another_project_is_loaded() {
        await _projects.GetProjectAsync(P("Lib/Lib.csproj"));
        await ChangeAsync("Lib/Person.cs", "namespace Lib; public class Person { public int Age { get; set; } }");
        // Other is not loaded yet: loading it must not bring back the old Person
        Assert.NotNull(await _projects.GetProjectAsync(P("Other/Other.csproj")));
        Assert.True(await HasMemberAsync((await _projects.GetProjectAsync(P("Lib/Lib.csproj")))!, "Lib.Person", "Age"));
    }

    [Fact]
    public async Task A_project_sees_changes_of_a_referenced_project() {
        await _projects.GetProjectAsync(P("App/App.csproj"));
        await ChangeAsync("Lib/Person.cs", "namespace Lib; public class Person { public int Age { get; set; } }");
        var app = (await _projects.GetProjectAsync(P("App/App.csproj")))!;
        var compilation = (await app.GetCompilationAsync())!;
        Assert.NotNull(compilation.GetTypeByMetadataName("Lib.Person")?.GetMembers("Age").FirstOrDefault());
    }

    [Fact]
    public async Task Only_projects_that_depend_on_a_change_get_a_new_version() {
        var app = (await _projects.GetProjectAsync(P("App/App.csproj")))!;
        var other = (await _projects.GetProjectAsync(P("Other/Other.csproj")))!;
        var appBefore = await app.GetDependentVersionAsync();
        var otherBefore = await other.GetDependentVersionAsync();

        await ChangeAsync("Lib/Person.cs", "namespace Lib; public class Person { public int Age { get; set; } }");

        Assert.NotEqual(appBefore, await (await _projects.GetProjectAsync(P("App/App.csproj")))!.GetDependentVersionAsync());
        Assert.Equal(otherBefore, await (await _projects.GetProjectAsync(P("Other/Other.csproj")))!.GetDependentVersionAsync());
    }

    [Fact]
    public async Task An_axaml_edit_changes_the_version_only_when_the_name_generator_reads_it() {
        var before = await (await _projects.GetProjectAsync(P("App/App.csproj")))!.GetDependentVersionAsync();

        await ChangeAsync("App/View.axaml", ProjectsFixture.View("Blue", "Save", "Button"));
        Assert.Equal(before, await (await _projects.GetProjectAsync(P("App/App.csproj")))!.GetDependentVersionAsync());

        await ChangeAsync("App/View.axaml", ProjectsFixture.View("Blue", "Cancel", "Button"));
        Assert.NotEqual(before, await (await _projects.GetProjectAsync(P("App/App.csproj")))!.GetDependentVersionAsync());
    }

    [Fact]
    public async Task Requests_for_two_projects_at_once_load_each_once() {
        var tasks = Enumerable.Range(0, 20)
            .Select(i => _projects.GetCompilationAsync(P(i % 2 == 0 ? "App/App.csproj" : "Other/Other.csproj")))
            .ToArray();
        var compilations = await Task.WhenAll(tasks);
        Assert.All(compilations, Assert.NotNull);
        Assert.NotNull(_projects.LoadedProject(P("App/App.csproj")));
        Assert.NotNull(_projects.LoadedProject(P("Other/Other.csproj")));
        // a compilation of the current snapshot is reused, not computed again
        Assert.Same(
            await _projects.GetCompilationAsync(P("Other/Other.csproj")),
            await _projects.GetCompilationAsync(P("Other/Other.csproj")));
    }

    [Fact]
    public async Task A_project_that_cannot_load_does_not_block_the_others() {
        Assert.NotNull(await _projects.GetProjectAsync(P("Other/Other.csproj")));
        ProjectsFixture.Write(_root, "Broken/Broken.csproj", "<Project this is not xml");
        await _projects.GetProjectAsync(P("Broken/Broken.csproj")); // loads with errors, or not at all
        // a change after the failed load: the others still load and compile
        await ChangeAsync("Other/Thing.cs", "namespace Other; public class Thing { public int Count; }");
        Assert.True(await HasMemberAsync((await _projects.GetProjectAsync(P("Other/Other.csproj")))!, "Other.Thing", "Count"));
    }

    [Fact]
    public async Task A_project_that_fails_to_load_does_not_hold_up_another_project() {
        // a project file that cannot be opened at all (the load throws): it waits before the next attempt
        Assert.Null(await _projects.GetProjectAsync(P("Missing/Missing.csproj")));
        // a different, working project is loaded right away, not after that wait
        Assert.NotNull(await _projects.GetProjectAsync(P("Other/Other.csproj")));
        Assert.NotNull(await _projects.GetProjectAsync(P("App/App.csproj")));
    }

    [Fact]
    public async Task A_project_file_change_reloads_from_disk() {
        await _projects.GetProjectAsync(P("Other/Other.csproj"));
        ProjectsFixture.Write(_root, "Other/Extra.cs", "namespace Other; public class Extra { }");
        await _projects.FileChangedAsync(P("Other/Extra.cs"), deleted: false);
        var compilation = await _projects.GetCompilationAsync(P("Other/Other.csproj"));
        Assert.NotNull(compilation!.GetTypeByMetadataName("Other.Extra"));
    }

    public void Dispose() {
        _projects.Dispose();
        try {
            Directory.Delete(_root, recursive: true);
        } catch (IOException) {
            // a build host may still hold a file
        }
    }
}

public sealed class GeneratorInputTests {
    [Fact]
    public void Ignores_attributes_the_name_generator_does_not_read() {
        Assert.Equal(
            RoslynProjects.GeneratorInput(ProjectsFixture.View("Red", "Save", "Button")),
            RoslynProjects.GeneratorInput(ProjectsFixture.View("Blue", "Save", "Button")));
    }

    [Fact]
    public void Sees_names_and_the_types_of_named_elements() {
        var original = RoslynProjects.GeneratorInput(ProjectsFixture.View("Red", "Save", "Button"));
        Assert.NotEqual(original, RoslynProjects.GeneratorInput(ProjectsFixture.View("Red", "Cancel", "Button")));
        Assert.NotEqual(original, RoslynProjects.GeneratorInput(ProjectsFixture.View("Red", "Save", "TextBox")));
    }

    const string Ns = "xmlns=\"https://github.com/avaloniaui\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";

    [Fact]
    public void Commenting_out_a_named_element_counts() {
        var named = $"<UserControl {Ns}><Button x:Name=\"Save\" /></UserControl>";
        var commented = $"<UserControl {Ns}><!-- <Button x:Name=\"Save\" /> --></UserControl>";
        Assert.NotEqual(RoslynProjects.GeneratorInput(named), RoslynProjects.GeneratorInput(commented));
    }

    [Fact]
    public void A_greater_than_sign_in_an_attribute_value_does_not_hide_a_later_name() {
        var before = $"<UserControl {Ns}><TextBlock Text=\"{{Binding A, StringFormat='>{{0}}'}}\" x:Name=\"First\" /></UserControl>";
        var after = $"<UserControl {Ns}><TextBlock Text=\"{{Binding A, StringFormat='>{{0}}'}}\" x:Name=\"Second\" /></UserControl>";
        Assert.NotEqual(RoslynProjects.GeneratorInput(before), RoslynProjects.GeneratorInput(after));
    }

    [Fact]
    public void A_changed_namespace_mapping_counts() {
        var a = $"<UserControl {Ns} xmlns:c=\"using:App.A\"><c:Card x:Name=\"Card\" /></UserControl>";
        var b = $"<UserControl {Ns} xmlns:c=\"using:App.B\"><c:Card x:Name=\"Card\" /></UserControl>";
        Assert.NotEqual(RoslynProjects.GeneratorInput(a), RoslynProjects.GeneratorInput(b));
    }
}

public sealed class LoadRetryTests {
    [Fact]
    public void The_wait_after_failed_loads_grows_and_is_capped() {
        Assert.Equal(TimeSpan.FromSeconds(3), RoslynProjects.RetryDelay(1));
        Assert.Equal(TimeSpan.FromSeconds(6), RoslynProjects.RetryDelay(2));
        Assert.Equal(TimeSpan.FromSeconds(12), RoslynProjects.RetryDelay(3));
        Assert.Equal(TimeSpan.FromSeconds(60), RoslynProjects.RetryDelay(20));
    }
}
