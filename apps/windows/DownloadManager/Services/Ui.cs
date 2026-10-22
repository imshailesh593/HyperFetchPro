using Microsoft.UI.Xaml;

namespace DownloadManager.Services;

/// <summary>Tiny helpers for x:Bind function bindings.</summary>
public static class Ui
{
    public static bool Not(bool value) => !value;
    public static Visibility Vis(bool visible) => visible ? Visibility.Visible : Visibility.Collapsed;
    public static Visibility VisIfEmpty(int count) => count == 0 ? Visibility.Visible : Visibility.Collapsed;
    public static Visibility VisIfText(string? text) => string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
}
