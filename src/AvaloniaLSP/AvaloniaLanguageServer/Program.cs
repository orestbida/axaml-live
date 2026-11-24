using AvaloniaLanguageServer.Handlers;
using AvaloniaLanguageServer.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;

namespace AvaloniaLanguageServer;

public class Program {
    static ILanguageServer? server;
    public static async Task Main(string[] args) {
        InitializeLogging();
        server = await LanguageServer.From(ConfigureOptions);

        Log.Logger.Information("Language server initialised");
        await server.WaitForExit;
    }

    static void ConfigureOptions(LanguageServerOptions options) {
        options
            .WithInput(Console.OpenStandardInput())
            .WithOutput(Console.OpenStandardOutput())
            .ConfigureLogging(p => p
                .AddSerilog(Log.Logger)
                .AddLanguageProtocolLogging()
                .SetMinimumLevel(LogLevel.Trace)
            )
            .WithHandler<CompletionHandler>()
            .WithHandler<TextDocumentSyncHandler>()
            .WithHandler<HoverHandler>()
            .WithHandler<DefinitionHandler>()
            .WithHandler<CodeActionHandler>()
            .WithHandler<WatchedFilesHandler>()
            .WithHandler<InlayHintHandler>()
            .WithServices(ConfigureServices)
            .OnInitialize((init_server, request, token) => {
                server = init_server;
                return Task.CompletedTask;
            });
    }

    static void ConfigureServices(IServiceCollection services) {
        services.AddSingleton(new ConfigurationItem { Section = "Avalonia Server" });
        services.AddSingleton(new TextDocumentSelector(
            new TextDocumentFilter { Pattern = "**/*.axaml" }
        ));
        services.AddSingleton<Workspace>();
        services.AddSingleton<AvaloniaLanguageServer.Services.DiagnosticsService>();
        services.AddSingleton(GetServer);
    }

    static ILanguageServer? GetServer() => server;

    static void InitializeLogging() {
        string logFilePath = Path.Combine(Path.GetTempPath(), "axaml-live.log");
        Log.Logger = new LoggerConfiguration()
            .WriteTo.File(logFilePath, shared: true)
            .Enrich.FromLogContext()
            .MinimumLevel.Verbose()
            .CreateLogger();
    }
}
