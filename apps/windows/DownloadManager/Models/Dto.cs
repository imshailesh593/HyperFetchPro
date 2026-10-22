namespace DownloadManager.Models;

public sealed class SegmentDto
{
    public double Start { get; set; }
    /// <summary>Null when the size is unknown (the host sends Infinity as null).</summary>
    public double? End { get; set; }
    public double Written { get; set; }

    public double Percent => End is > 0 ? Math.Min(100, Written * 100 / (End.Value - Start)) : 0;
    public string RangeText => $"{DownloadManager.Services.Fmt.Bytes((long)Start)} – {(End is null ? "…" : DownloadManager.Services.Fmt.Bytes((long)End.Value))}";
    public string WrittenText => DownloadManager.Services.Fmt.Bytes((long)Written);
}

public sealed class DownloadDto
{
    public int Id { get; set; }
    public string Url { get; set; } = "";
    public string? FinalUrl { get; set; }
    public string Dir { get; set; } = "";
    public string Filename { get; set; } = "";
    public long? Size { get; set; }
    public long Downloaded { get; set; }
    public string Status { get; set; } = "paused";
    public int? CategoryId { get; set; }
    public int? QueueId { get; set; }
    public string? Error { get; set; }
    public int Attempts { get; set; }
    public string? Etag { get; set; }
    public string? LastModified { get; set; }
}

public sealed class QueueDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "download";
    public int MaxParallel { get; set; }
    public bool Running { get; set; }
}

public sealed class CategoryDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Extensions { get; set; } = [];
    public string? SaveDir { get; set; }
}

public sealed class SettingsDto
{
    public string DefaultDir { get; set; } = "";
    public double SpeedLimit { get; set; }
    public int MaxConnections { get; set; } = 8;
}

public sealed class SnapshotDto
{
    public List<DownloadDto> Downloads { get; set; } = [];
    public List<QueueDto> Queues { get; set; } = [];
    public List<CategoryDto> Categories { get; set; } = [];
    public SettingsDto Settings { get; set; } = new();
}

public sealed class ProgressDto
{
    public int Id { get; set; }
    public long Downloaded { get; set; }
    public long? Size { get; set; }
    public double Speed { get; set; }
    public List<SegmentDto> Segments { get; set; } = [];
}
