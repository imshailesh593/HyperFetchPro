using DownloadManager.Models;
using DownloadManager.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;

namespace DownloadManager;

public sealed partial class SettingsDialog : ContentDialog
{
    private readonly Window _owner;
    private readonly MainViewModel _vm;
    private bool _ytInstalled;

    public SettingsDialog(Window owner, XamlRoot root, MainViewModel vm)
    {
        _owner = owner;
        _vm = vm;
        InitializeComponent();
        XamlRoot = root;

        FolderBox.Text = vm.DefaultDir;
        ConnBox.Value = vm.MaxConnections;
        SpeedBox.Value = vm.SpeedLimitMb >= MainViewModel.UnlimitedSliderValue ? 0 : vm.SpeedLimitMb;
        QuotaMbBox.Value = vm.QuotaMb;
        QuotaHoursBox.Value = vm.QuotaHours;
        AutoUpdateBox.IsChecked = vm.AutoUpdateYtDlp;
        DataText.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DownloadManager")
            + "\nDownload list and settings: downloads.db. Video tools: bin\\. Crash log: %LOCALAPPDATA%\\DownloadManager\\crash.log";
        Loaded += async (_, _) => await RefreshToolsAsync();
    }

    public string Folder => FolderBox.Text.Trim();
    public int Connections => (int)Math.Clamp(double.IsNaN(ConnBox.Value) ? 8 : ConnBox.Value, 1, 32);
    public double QuotaMb => double.IsNaN(QuotaMbBox.Value) ? 0 : Math.Max(0, QuotaMbBox.Value);
    public double QuotaHours => double.IsNaN(QuotaHoursBox.Value) ? 1 : Math.Clamp(QuotaHoursBox.Value, 0.1, 720);
    public bool AutoUpdate => AutoUpdateBox.IsChecked == true;
    public double SpeedMb => double.IsNaN(SpeedBox.Value) ? 0 : Math.Max(0, SpeedBox.Value);

    private void Folder_TextChanged(object sender, TextChangedEventArgs e)
    {
        var ok = Path.IsPathRooted(Folder) && Folder.IndexOfAny(Path.GetInvalidPathChars()) < 0;
        IsPrimaryButtonEnabled = ok;
        FolderError.Text = ok ? "" : "Enter a full folder path, for example D:\\Downloads.";
        FolderError.Visibility = ok ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void Browse_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.Downloads };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(_owner));
        var folder = await picker.PickSingleFolderAsync();
        if (folder != null) FolderBox.Text = folder.Path;
    }

    // --- video tools ------------------------------------------------------------------

    private async Task RefreshToolsAsync()
    {
        try
        {
            var s = await _vm.MediaStatusAsync();
            YtDlpText.Text = s.YtDlp is null ? "yt-dlp: not installed" : $"yt-dlp: {s.YtDlp.Version ?? "installed"}";
            _ytInstalled = s.YtDlp is not null;
            YtDlpButton.Content = s.YtDlp is null ? "Install" : "Check for update";
            FfmpegText.Text = s.Ffmpeg is null ? "ffmpeg: not installed (needed to merge video and audio)" : "ffmpeg: installed";
            FfmpegButton.Visibility = s.Ffmpeg is null ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            ToolStatus.Text = ex.Message;
        }
    }

    private void Busy(bool busy, string text)
    {
        ToolRing.IsActive = busy;
        ToolRing.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        YtDlpButton.IsEnabled = FfmpegButton.IsEnabled = !busy;
        ToolStatus.Text = text;
    }

    private async void YtDlp_Click(object sender, RoutedEventArgs e)
    {
        if (!_ytInstalled)
        {
            await RunTool("Downloading yt-dlp…", _vm.InstallYtDlpAsync, "yt-dlp installed.");
            return;
        }
        UpdateResultDto? result = null;
        await RunTool("Checking for a newer yt-dlp…", async () => result = await _vm.UpdateYtDlpAsync(), "");
        if (result is not null)
            ToolStatus.Text = result.Updated ? $"Updated yt-dlp from {result.From ?? "none"} to {result.To}." : $"yt-dlp is up to date ({result.To}).";
    }

    private async void Ffmpeg_Click(object sender, RoutedEventArgs e) =>
        await RunTool("Downloading ffmpeg (about 130 MB)…", _vm.InstallFfmpegAsync, "ffmpeg installed.");

    private async Task RunTool(string working, Func<Task> action, string done)
    {
        Busy(true, working);
        try
        {
            await action();
            await RefreshToolsAsync();
            Busy(false, done);
        }
        catch (Exception ex)
        {
            Busy(false, "Failed: " + ex.Message);
        }
    }
}
