using System.Collections.ObjectModel;
using System.Text.Json;
using DownloadManager.Models;
using DownloadManager.Services;

namespace DownloadManager.ViewModels;

public sealed class CategoryEntry : Observable
{
    private int _count;
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public string Glyph { get; init; } = "";
    public int Count { get => _count; set => Set(ref _count, value); }
}

/// <summary>UI state. All methods run on the UI thread; the window marshals host events onto it.</summary>
public sealed class MainViewModel : Observable
{
    public const int MainDownloadQueue = 1;
    public const int SpeedHistoryLength = 60;
    public const double UnlimitedSliderValue = 200;

    private readonly CoreClient _core;
    private readonly List<DownloadItem> _all = [];
    private readonly Dictionary<int, string> _categoryNames = [];
    private readonly Queue<double> _speedHistory = new();

    private string _filter = "all";
    private int? _categoryFilter;
    private string _search = "";
    private double _totalSpeed;
    private bool _connected;
    private string _connectionText = "Starting engine…";
    private bool _queueRunning;
    private int _maxConnections = 8;
    private double _speedLimitMb = UnlimitedSliderValue;
    private string _defaultDir = "";

    public MainViewModel(CoreClient core) => _core = core;

    public ObservableCollection<DownloadItem> Visible { get; } = [];
    public ObservableCollection<CategoryEntry> Categories { get; } = [];
    public IReadOnlyList<CategoryDto> CategoryList { get; private set; } = [];

    public string Filter => _filter;
    public int? CategoryFilter => _categoryFilter;
    public int CountAll => _all.Count;
    public int CountDownloading => _all.Count(d => d.IsRunning);
    public int CountCompleted => _all.Count(d => d.IsCompleted);
    public int CountPaused => _all.Count(d => d.Status is "paused" or "queued" or "failed");
    public int ActiveConnections => _all.Sum(d => d.ActiveConnections);

    public double TotalSpeed { get => _totalSpeed; private set { if (Set(ref _totalSpeed, value)) Raise(nameof(TotalSpeedValue), nameof(TotalSpeedUnit)); } }
    public string TotalSpeedValue => Fmt.Speed(_totalSpeed) is { } s && _totalSpeed > 0 ? s.Split(' ')[0] : "0";
    public string TotalSpeedUnit => _totalSpeed > 0 ? Fmt.Speed(_totalSpeed).Split(' ')[1] : "B/s";
    public IReadOnlyCollection<double> SpeedHistory => _speedHistory;

    public bool Connected { get => _connected; private set => Set(ref _connected, value); }
    public string ConnectionText { get => _connectionText; private set => Set(ref _connectionText, value); }
    public bool QueueRunning { get => _queueRunning; private set => Set(ref _queueRunning, value); }
    public int MaxConnections { get => _maxConnections; private set { if (Set(ref _maxConnections, value)) Raise(nameof(TurboOn), nameof(TurboLabel)); } }
    public bool TurboOn => _maxConnections >= 32;
    public string TurboLabel => TurboOn ? "Turbo: 32 connections" : $"Standard: {_maxConnections} connections";
    public double SpeedLimitMb { get => _speedLimitMb; private set { if (Set(ref _speedLimitMb, value)) Raise(nameof(SpeedLimitText)); } }
    public string SpeedLimitText => _speedLimitMb >= UnlimitedSliderValue ? "UNLIMITED" : $"{_speedLimitMb:0.#} MB/s";
    public string DefaultDir { get => _defaultDir; private set => Set(ref _defaultDir, value); }

    // --- loading ---------------------------------------------------------------

    public async Task LoadAsync()
    {
        var snap = await _core.CallAsync<SnapshotDto>("state.snapshot");
        CategoryList = snap.Categories;
        _categoryNames.Clear();
        Categories.Clear();
        foreach (var c in snap.Categories)
        {
            _categoryNames[c.Id] = c.Name;
            Categories.Add(new CategoryEntry { Id = c.Id, Name = c.Name, Glyph = GlyphFor(c.Name) });
        }

        _all.Clear();
        _all.AddRange(snap.Downloads.OrderByDescending(d => d.Id).Select(d => DownloadItem.From(d, CategoryName)));
        QueueRunning = snap.Queues.FirstOrDefault(q => q.Id == MainDownloadQueue)?.Running ?? false;
        DefaultDir = snap.Settings.DefaultDir;
        MaxConnections = snap.Settings.MaxConnections;
        SpeedLimitMb = snap.Settings.SpeedLimit > 0 ? Math.Clamp(Math.Round(snap.Settings.SpeedLimit / 1048576, 1), 0.1, UnlimitedSliderValue - 1) : UnlimitedSliderValue;
        Connected = true;
        ConnectionText = "Engine running";
        Refresh();
    }

    public void MarkDisconnected(string reason)
    {
        Connected = false;
        ConnectionText = reason;
    }

    // --- events from the host --------------------------------------------------

    public void OnEvent(string name, JsonElement data)
    {
        switch (name)
        {
            case "download.changed":
                Upsert(data.GetProperty("download").Deserialize<DownloadDto>(CoreClient.Json)!);
                break;
            case "download.progress":
                var p = data.Deserialize<ProgressDto>(CoreClient.Json)!;
                _all.FirstOrDefault(d => d.Id == p.Id)?.ApplyProgress(p);
                UpdateSpeed();
                break;
            case "download.removed":
                var id = data.GetProperty("id").GetInt32();
                if (_all.RemoveAll(d => d.Id == id) > 0) Refresh();
                break;
            case "queue.changed":
                if (data.GetProperty("queueId").GetInt32() == MainDownloadQueue)
                    QueueRunning = data.GetProperty("running").GetBoolean();
                break;
        }
    }

    private void Upsert(DownloadDto dto)
    {
        var existing = _all.FirstOrDefault(d => d.Id == dto.Id);
        if (existing is null) _all.Insert(0, DownloadItem.From(dto, CategoryName));
        else existing.Apply(dto, CategoryName);
        Refresh();
    }

    private string CategoryName(int? id) => id is { } i && _categoryNames.TryGetValue(i, out var n) ? n : "Other";

    // --- filtering -------------------------------------------------------------

    public void SetFilter(string filter)
    {
        _filter = filter;
        _categoryFilter = null;
        Refresh();
    }

    public void SetCategoryFilter(int categoryId)
    {
        _filter = "all";
        _categoryFilter = categoryId;
        Refresh();
    }

    public void SetSearch(string text)
    {
        _search = text.Trim();
        Refresh();
    }

    private bool Matches(DownloadItem d) =>
        (_filter switch
        {
            "downloading" => d.IsRunning,
            "completed" => d.IsCompleted,
            "paused" => d.Status is "paused" or "queued" or "failed",
            _ => true,
        })
        && (_categoryFilter is null || d.CategoryId == _categoryFilter)
        && (_search.Length == 0 || d.Filename.Contains(_search, StringComparison.OrdinalIgnoreCase)
            || d.Url.Contains(_search, StringComparison.OrdinalIgnoreCase));

    /// <summary>Reconciles the visible list in place so selection and scroll position survive.</summary>
    public void Refresh()
    {
        for (var i = Visible.Count - 1; i >= 0; i--)
            if (!_all.Contains(Visible[i]) || !Matches(Visible[i])) Visible.RemoveAt(i);
        var vi = 0;
        foreach (var d in _all)
        {
            if (!Matches(d)) continue;
            if (vi >= Visible.Count || !ReferenceEquals(Visible[vi], d)) Visible.Insert(vi, d);
            vi++;
        }

        foreach (var c in Categories) c.Count = _all.Count(d => d.CategoryId == c.Id);
        Raise(nameof(CountAll), nameof(CountDownloading), nameof(CountCompleted), nameof(CountPaused), nameof(ActiveConnections));
        UpdateSpeed();
    }

    private void UpdateSpeed()
    {
        TotalSpeed = _all.Where(d => d.IsRunning).Sum(d => d.Speed);
        _speedHistory.Enqueue(_totalSpeed);
        while (_speedHistory.Count > SpeedHistoryLength) _speedHistory.Dequeue();
        Raise(nameof(SpeedHistory), nameof(ActiveConnections));
    }

    // --- commands --------------------------------------------------------------

    public Task AddAsync(string url, bool startNow, int? categoryId, string? dir, Dictionary<string, string>? headers) =>
        _core.CallAsync("download.add", new { url, startNow, categoryId, dir, headers });

    public Task PauseAsync(DownloadItem d) => _core.CallAsync("download.pause", new { id = d.Id });
    public Task ResumeAsync(DownloadItem d) => _core.CallAsync("download.start", new { id = d.Id });
    public Task RemoveAsync(DownloadItem d, bool deleteFiles) => _core.CallAsync("download.remove", new { id = d.Id, deleteFiles });
    public Task PauseAllAsync() => _core.CallAsync("downloads.pauseAll");
    public Task ResumeAllAsync() => _core.CallAsync("downloads.resumeAll");
    public Task StartQueueAsync() => _core.CallAsync("queue.start", new { id = MainDownloadQueue });
    public Task StopQueueAsync() => _core.CallAsync("queue.stop", new { id = MainDownloadQueue });

    public async Task SetTurboAsync(bool on)
    {
        var n = on ? 32 : 8;
        await _core.CallAsync("settings.set", new { maxConnections = n });
        MaxConnections = n;
    }

    public async Task SetSpeedLimitAsync(double mb)
    {
        SpeedLimitMb = mb;
        await _core.CallAsync("settings.set", new { speedLimit = mb >= UnlimitedSliderValue ? 0 : (long)(mb * 1048576) });
    }

    // --- options ---------------------------------------------------------------------

    /// <summary>Saves the Options dialog. A speed of 0 (or the slider maximum) means unlimited.</summary>
    public async Task SaveSettingsAsync(string dir, int connections, double speedMb)
    {
        var unlimited = speedMb <= 0 || speedMb >= UnlimitedSliderValue;
        await _core.CallAsync("settings.set", new
        {
            defaultDir = dir,
            maxConnections = connections,
            speedLimit = unlimited ? 0L : (long)(speedMb * 1048576),
        });
        DefaultDir = dir;
        MaxConnections = connections;
        SpeedLimitMb = unlimited ? UnlimitedSliderValue : speedMb;
    }

    /// <summary>Downloads the latest yt-dlp (also used to update it).</summary>
    public Task InstallYtDlpAsync() => _core.CallAsync("media.install");
    public Task InstallFfmpegAsync() => _core.CallAsync("media.installFfmpeg");

    // --- video downloads ---------------------------------------------------------

    public Task<MediaStatusDto> MediaStatusAsync() => _core.CallAsync<MediaStatusDto>("media.status");

    public Task<MediaInfoDto> MediaInfoAsync(string url, Dictionary<string, string>? headers) =>
        _core.CallAsync<MediaInfoDto>("media.info", new { url, headers });

    /// <summary>Installs whichever of yt-dlp and ffmpeg is missing (downloaded and checksum-verified by the core).</summary>
    public async Task InstallMediaToolsAsync(Action<string>? status = null)
    {
        var st = await MediaStatusAsync();
        if (st.YtDlp is null)
        {
            status?.Invoke("Downloading yt-dlp…");
            await _core.CallAsync("media.install");
        }
        if (st.Ffmpeg is null)
        {
            status?.Invoke("Downloading ffmpeg (about 130 MB)…");
            await _core.CallAsync("media.installFfmpeg");
        }
    }

    public Task AddMediaAsync(string url, MediaInfoDto info, MediaFormatDto format, bool startNow, string? dir, Dictionary<string, string>? headers) =>
        _core.CallAsync("media.add", new { url, title = info.Title, format = format.Id, ext = format.Ext, startNow, dir, headers });

    private static string GlyphFor(string category) => category switch
    {
        "Video" => "",
        "Music" => "",
        "Compressed" => "",
        "Programs" => "",
        "Documents" => "",
        _ => "",
    };
}
