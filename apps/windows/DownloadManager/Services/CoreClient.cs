using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace DownloadManager.Services;

/// <summary>Talks to the Node core host over stdio: newline-delimited JSON requests, replies and events.</summary>
public sealed class CoreClient : IDisposable
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private Process? _process;
    private int _nextId;

    /// <summary>Raised on a background thread for every host event.</summary>
    public event Action<string, JsonElement>? EventReceived;
    public event Action<string>? Exited;

    public bool IsRunning => _process is { HasExited: false };

    public void Start()
    {
        var host = FindHost();
        var psi = new ProcessStartInfo(FindNode())
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardInputEncoding = new System.Text.UTF8Encoding(false),
        };
        psi.ArgumentList.Add(host);

        _process = Process.Start(psi) ?? throw new InvalidOperationException("Could not start the core host.");
        _ = Task.Run(ReadLoop);
        _ = Task.Run(async () =>
        {
            string? line;
            while ((line = await _process.StandardError.ReadLineAsync()) != null)
                Debug.WriteLine("[core] " + line);
        });
    }

    public async Task<JsonElement> CallAsync(string method, object? parameters = null, CancellationToken ct = default)
    {
        var proc = _process;
        if (proc is not { HasExited: false }) throw new InvalidOperationException("Core host is not running.");
        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        var line = JsonSerializer.Serialize(new { id, method, @params = parameters ?? new { } }, Json);
        lock (proc)
        {
            proc.StandardInput.WriteLine(line);
            proc.StandardInput.Flush();
        }
        using var reg = ct.Register(() => tcs.TrySetCanceled(ct));
        return await tcs.Task.ConfigureAwait(false);
    }

    public async Task<T> CallAsync<T>(string method, object? parameters = null)
    {
        var el = await CallAsync(method, parameters).ConfigureAwait(false);
        return el.Deserialize<T>(Json)!;
    }

    private async Task ReadLoop()
    {
        var proc = _process!;
        string? line;
        try
        {
            while ((line = await proc.StandardOutput.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                if (line.Length == 0) continue;
                try { Dispatch(line); }
                catch (Exception ex) { Debug.WriteLine("[core] bad message: " + ex.Message); }
            }
        }
        catch (Exception ex) { Debug.WriteLine("[core] read loop: " + ex.Message); }

        foreach (var (_, tcs) in _pending) tcs.TrySetException(new IOException("Core host exited."));
        _pending.Clear();
        Exited?.Invoke("The download engine stopped.");
    }

    private void Dispatch(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.TryGetProperty("event", out var ev))
        {
            // Clone: the document is disposed when this method returns.
            EventReceived?.Invoke(ev.GetString()!, root.GetProperty("data").Clone());
            return;
        }
        if (!root.TryGetProperty("id", out var idEl) || !_pending.TryRemove(idEl.GetInt32(), out var tcs)) return;
        if (root.TryGetProperty("error", out var err)) tcs.TrySetException(new InvalidOperationException(err.GetString()));
        else tcs.TrySetResult(root.GetProperty("result").Clone());
    }

    /// <summary>DM_NODE, then the Node that ships with the app (core/node.exe), then node.exe on PATH.</summary>
    private static string FindNode()
    {
        var fromEnv = Environment.GetEnvironmentVariable("DM_NODE");
        if (!string.IsNullOrEmpty(fromEnv)) return fromEnv;
        var bundled = Path.Combine(AppContext.BaseDirectory, "core", "node.exe");
        return File.Exists(bundled) ? bundled : "node.exe";
    }

    private static string FindHost()
    {
        var fromEnv = Environment.GetEnvironmentVariable("DM_CORE_HOST");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return fromEnv;

        var bundled = Path.Combine(AppContext.BaseDirectory, "core", "host.mjs");
        if (File.Exists(bundled)) return bundled;

        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var dev = Path.Combine(dir.FullName, "apps", "core-host", "dist", "host.mjs");
            if (File.Exists(dev)) return dev;
        }
        throw new FileNotFoundException("Core host (host.mjs) not found. Run `npm run build` in apps/core-host.");
    }

    public void Dispose()
    {
        try
        {
            _process?.StandardInput.Close(); // the host shuts down when stdin closes
            if (_process is { HasExited: false } && !_process.WaitForExit(4000)) _process.Kill(true);
        }
        catch { /* already gone */ }
    }
}
