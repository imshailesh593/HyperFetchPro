using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace DownloadManager.Controls;

/// <summary>A row of equal cells; each shows how much of its slice of the file is downloaded.</summary>
public sealed class SegmentStrip : Grid
{
    private static readonly SolidColorBrush Empty = new(Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF));
    private static readonly SolidColorBrush Partial = new(Color.FromArgb(0xFF, 0x79, 0x28, 0xCA));
    private static readonly SolidColorBrush Full = new(Color.FromArgb(0xFF, 0x00, 0xF2, 0xFE));

    public static readonly DependencyProperty BucketsProperty = DependencyProperty.Register(
        nameof(Buckets), typeof(double[]), typeof(SegmentStrip),
        new PropertyMetadata(null, (d, _) => ((SegmentStrip)d).Refresh()));

    private readonly Border[] _cells;

    public double[]? Buckets
    {
        get => (double[]?)GetValue(BucketsProperty);
        set => SetValue(BucketsProperty, value);
    }

    public SegmentStrip() : this(32)
    {
    }

    private SegmentStrip(int cells)
    {
        _cells = new Border[cells];
        ColumnSpacing = 2;
        Height = 8;
        for (var i = 0; i < cells; i++)
        {
            ColumnDefinitions.Add(new ColumnDefinition());
            var cell = new Border { CornerRadius = new CornerRadius(1.5), Background = Empty };
            Grid.SetColumn(cell, i);
            Children.Add(cell);
            _cells[i] = cell;
        }
    }

    private void Refresh()
    {
        var b = Buckets;
        for (var i = 0; i < _cells.Length; i++)
        {
            var v = b is not null && i < b.Length ? b[i] : 0;
            _cells[i].Background = v >= 0.999 ? Full : v > 0.001 ? Partial : Empty;
        }
    }
}
