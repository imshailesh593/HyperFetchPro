using DownloadManager.Services;
using Microsoft.UI;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace DownloadManager.Models;

/// <summary>One row in the download list. Updated in place so the UI never rebuilds the row.</summary>
public sealed class DownloadItem : Observable
{
    public const int BucketCount = 32;

    private static readonly SolidColorBrush Cyan = Brush(0x00, 0xF2, 0xFE);
    private static readonly SolidColorBrush Emerald = Brush(0x00, 0xF5, 0xA0);
    private static readonly SolidColorBrush Amber = Brush(0xFF, 0xB3, 0x00);
    private static readonly SolidColorBrush Rose = Brush(0xFF, 0x5C, 0x7A);
    private static readonly SolidColorBrush Purple = Brush(0xB3, 0x6B, 0xFF);
    private static readonly SolidColorBrush Pink = Brush(0xFF, 0x4D, 0xA6);
    private static readonly SolidColorBrush Gray = Brush(0x9A, 0xA0, 0xB4);

    private static SolidColorBrush Brush(byte r, byte g, byte b) => new(Color.FromArgb(0xFF, r, g, b));

    private long? _size;
    private long _downloaded;
    private string _status = "paused";
    private double _speed;
    private string? _error;
    private string _filename = "";
    private string _categoryName = "";
    private double[] _buckets = new double[BucketCount];
    private List<SegmentDto> _segments = [];

    public int Id { get; private set; }
    public string Url { get; private set; } = "";
    public string? FinalUrl { get; private set; }
    public string Dir { get; private set; } = "";
    public string Domain { get; private set; } = "";
    public int? CategoryId { get; private set; }
    public int? QueueId { get; private set; }
    public int Attempts { get; private set; }
    public string? Etag { get; private set; }
    public string? LastModified { get; private set; }

    public string Filename { get => _filename; private set => Set(ref _filename, value); }
    public string CategoryName { get => _categoryName; private set => Set(ref _categoryName, value); }
    public long? Size { get => _size; private set => Set(ref _size, value); }
    public long Downloaded { get => _downloaded; private set => Set(ref _downloaded, value); }
    public string Status { get => _status; private set => Set(ref _status, value); }
    public double Speed { get => _speed; private set => Set(ref _speed, value); }
    public string? Error { get => _error; private set => Set(ref _error, value); }
    public double[] Buckets { get => _buckets; private set => Set(ref _buckets, value); }
    public IReadOnlyList<SegmentDto> Segments => _segments;

    public string FullPath => Path.Combine(Dir, Filename);
    public bool IsRunning => Status == "running";
    public bool IsCompleted => Status == "completed";
    public bool CanPause => Status == "running";
    public bool CanResume => Status is "paused" or "failed" or "queued";

    public double Percent => Size is > 0 ? Math.Min(100, Downloaded * 100.0 / Size.Value) : 0;
    public string PercentText => IsCompleted ? "100%" : Size is > 0 ? $"{(int)Percent}%" : "—";
    public string SizeText => Size is > 0 ? Fmt.Bytes(Size.Value) : "—";
    public string ProgressText => Size is > 0 ? $"{Fmt.Bytes(Downloaded)} / {Fmt.Bytes(Size.Value)}" : Fmt.Bytes(Downloaded);
    public string SpeedText => IsRunning ? Fmt.Speed(Speed) : "—";
    public string EtaText => IsCompleted ? "Done" : IsRunning && Speed > 0 && Size is > 0 ? Fmt.Eta((Size.Value - Downloaded) / Speed) : "—";
    public int ActiveConnections => IsRunning ? _segments.Count(s => s.End is null || s.Start + s.Written < s.End) : 0;
    public string ConnectionsText => IsRunning ? $"{ActiveConnections} connections" : "";
    public string StatusText => Status switch
    {
        "running" => "Downloading",
        "completed" => "Completed",
        "queued" => "Queued",
        "failed" => string.IsNullOrEmpty(Error) ? "Failed" : "Failed: " + Error,
        _ => "Paused",
    };

    public Brush StatusBrush => Status switch
    {
        "running" => Cyan,
        "completed" => Emerald,
        "failed" => Rose,
        _ => Amber,
    };

    public string IconGlyph => Path.GetExtension(Filename).TrimStart('.').ToLowerInvariant() switch
    {
        "mp4" or "mkv" or "avi" or "mov" or "wmv" or "webm" or "m4v" or "flv" => "",
        "mp3" or "flac" or "wav" or "aac" or "ogg" or "m4a" => "",
        "zip" or "rar" or "7z" or "gz" or "tar" or "bz2" or "xz" => "",
        "iso" or "exe" or "msi" or "dmg" or "pkg" => "",
        "pdf" or "doc" or "docx" or "xls" or "xlsx" or "ppt" or "pptx" or "txt" => "",
        _ => "",
    };

    public Brush IconBrush => Path.GetExtension(Filename).TrimStart('.').ToLowerInvariant() switch
    {
        "mp4" or "mkv" or "avi" or "mov" or "wmv" or "webm" or "m4v" or "flv" => Rose,
        "mp3" or "flac" or "wav" or "aac" or "ogg" or "m4a" => Purple,
        "zip" or "rar" or "7z" or "gz" or "tar" or "bz2" or "xz" => Amber,
        "iso" or "exe" or "msi" or "dmg" or "pkg" => Cyan,
        "pdf" or "doc" or "docx" or "xls" or "xlsx" or "ppt" or "pptx" or "txt" => Pink,
        _ => Gray,
    };

    public static DownloadItem From(DownloadDto d, Func<int?, string> categoryName)
    {
        var item = new DownloadItem();
        item.Apply(d, categoryName);
        return item;
    }

    public void Apply(DownloadDto d, Func<int?, string> categoryName)
    {
        Id = d.Id;
        Url = d.Url;
        FinalUrl = d.FinalUrl;
        Dir = d.Dir;
        CategoryId = d.CategoryId;
        QueueId = d.QueueId;
        Attempts = d.Attempts;
        Etag = d.Etag;
        LastModified = d.LastModified;
        Domain = Uri.TryCreate(d.Url, UriKind.Absolute, out var uri) ? uri.Host : "";
        CategoryName = categoryName(d.CategoryId);
        Filename = d.Filename;
        Size = d.Size;
        Error = d.Error;
        var wasRunning = IsRunning;
        Status = d.Status;
        if (!(d.Status == "running" && Downloaded > d.Downloaded)) Downloaded = d.Downloaded; // keep live progress
        if (d.Status != "running") Speed = 0;
        if (wasRunning && !IsRunning) _segments = d.Status == "completed" ? [] : _segments;
        RecomputeBuckets();
        Raise(nameof(FullPath), nameof(IsRunning), nameof(IsCompleted), nameof(CanPause), nameof(CanResume),
            nameof(StatusText), nameof(StatusBrush), nameof(IconGlyph), nameof(IconBrush), nameof(Domain),
            nameof(CategoryName), nameof(SizeText), nameof(Percent), nameof(PercentText), nameof(ProgressText),
            nameof(SpeedText), nameof(EtaText), nameof(ActiveConnections), nameof(ConnectionsText), nameof(Segments));
    }

    public void ApplyProgress(ProgressDto p)
    {
        Downloaded = p.Downloaded;
        if (p.Size is not null) Size = p.Size;
        Speed = p.Speed;
        _segments = p.Segments;
        RecomputeBuckets();
        Raise(nameof(Percent), nameof(PercentText), nameof(ProgressText), nameof(SpeedText), nameof(EtaText),
            nameof(ActiveConnections), nameof(ConnectionsText), nameof(Segments));
    }

    /// <summary>
    /// Folds the engine's segments into 32 equal slices of the file; each slice is 0..1 filled.
    /// Without segment data (rows loaded from disk) it falls back to a contiguous fill.
    /// </summary>
    private void RecomputeBuckets()
    {
        var b = new double[BucketCount];
        if (IsCompleted) Array.Fill(b, 1.0);
        else if (Size is > 0)
        {
            double size = Size.Value;
            if (_segments.Count > 0)
            {
                for (var i = 0; i < BucketCount; i++)
                {
                    double lo = size * i / BucketCount, hi = size * (i + 1) / BucketCount, covered = 0;
                    foreach (var s in _segments)
                    {
                        var overlap = Math.Min(hi, s.Start + s.Written) - Math.Max(lo, s.Start);
                        if (overlap > 0) covered += overlap;
                    }
                    b[i] = Math.Min(1, covered / (hi - lo));
                }
            }
            else
            {
                var filled = Downloaded / size * BucketCount;
                for (var i = 0; i < BucketCount; i++) b[i] = Math.Clamp(filled - i, 0, 1);
            }
        }
        Buckets = b;
    }
}
