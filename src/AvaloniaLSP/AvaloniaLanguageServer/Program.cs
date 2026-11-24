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
            .ConfigureLogging(p => {
                p.AddSerilog(Log.Logger).SetMinimumLevel(Verbose ? LogLevel.Trace : LogLevel.Information);
                if (Verbose) {
                    p.AddLanguageProtocolLogging();
                }
            })
            .WithHandler<CompletionHandler>()
            .WithHandler<TextDocumentSyncHandler>()
            .WithHandler<HoverHandler>()
            .WithHandler<DefinitionHandler>()
            .WithHandler<CodeActionHandler>()
            .WithHandler<WatchedFilesHandler>()
            .WithHandler<InlayHintHandler>()
            .WithHandler<DocumentSymbolHandler>()
            .WithServices(ConfigureServices)
            .OnInitialize((init_server, request, token) => {
                server = init_server;
                return Task.CompletedTask;
            });
    }

    static void ConfigureServices(IServiceCollection services) {
        services.AddSingleton(new ConfigurationItem { Section = "Avalonia Server" });
        services.AddSingleton(new TextDocumentSelector(
            // by language: .xaml files of Avalonia projects are switched to AXAML by the extension
            new TextDocumentFilter { Language = "AXAML" },
            new TextDocumentFilter { Pattern = "**/*.axaml" }
        ));
        services.AddSingleton<Workspace>();
        services.AddSingleton<AvaloniaLanguageServer.Services.DiagnosticsService>();
        services.AddSingleton(GetServer);
    }

    static ILanguageServer? GetServer() => server;

    /// <summary>AXAML_LIVE_LSP_VERBOSE=1 logs everything, including the protocol messages (document text).</summary>
    static readonly bool Verbose = Environment.GetEnvironmentVariable("AXAML_LIVE_LSP_VERBOSE") == "1";

    static void InitializeLogging() {
        string logFilePath = Path.Combine(Path.GetTempPath(), "axaml-live.log");
        Log.Logger = new LoggerConfiguration()
            .WriteTo.File(logFilePath, shared: true, rollOnFileSizeLimit: true, fileSizeLimitBytes: 10 * 1024 * 1024, retainedFileCountLimit: 2)
            .Enrich.FromLogContext()
            .MinimumLevel.Is(Verbose ? Serilog.Events.LogEventLevel.Verbose : Serilog.Events.LogEventLevel.Information)
            .CreateLogger();
    }
}
