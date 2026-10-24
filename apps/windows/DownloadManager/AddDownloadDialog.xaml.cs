using DownloadManager.Models;
using DownloadManager.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage.Pickers;

namespace DownloadManager;

public sealed partial class AddDownloadDialog : ContentDialog
{
    private sealed record CategoryChoice(int? Id, string Name)
    {
        public override string ToString() => Name;
    }

    /// <summary>A video the user picked a quality for; null means a plain file download.</summary>
    public sealed record MediaChoice(MediaInfoDto Info, MediaFormatDto Format);

    /// <summary>The videos ticked in a playlist, with the quality chosen for all of them.</summary>
    public sealed record PlaylistChoice(IReadOnlyList<PlaylistEntryDto> Entries, MediaFormatDto Format);

    private readonly Window _owner;
    private readonly MainViewModel _vm;
    private MediaInfoDto? _info;

    public AddDownloadDialog(Window owner, XamlRoot root, MainViewModel vm)
    {
        _owner = owner;
        _vm = vm;
        InitializeComponent();
        XamlRoot = root;

        CategoryBox.Items.Add(new CategoryChoice(null, "Automatic (by file type)"));
        foreach (var c in vm.CategoryList) CategoryBox.Items.Add(new CategoryChoice(c.Id, c.Name));
        CategoryBox.SelectedIndex = 0;
        Loaded += async (_, _) => await TryPasteFromClipboardAsync(auto: true);
    }

    public string Url => UrlBox.Text.Trim();
    public int? CategoryId => (CategoryBox.SelectedItem as CategoryChoice)?.Id;
    public string? Folder => string.IsNullOrWhiteSpace(FolderBox.Text) ? null : FolderBox.Text.Trim();

    public MediaChoice? SelectedMedia =>
        _info is not null && _info.Playlist is null && QualityBox.Visibility == Visibility.Visible && QualityBox.SelectedItem is MediaFormatDto f
            ? new MediaChoice(_info, f)
            : null;

    public PlaylistChoice? SelectedPlaylist =>
        _info?.Playlist is not null && PlaylistPanel.Visibility == Visibility.Visible && QualityBox.SelectedItem is MediaFormatDto f
            ? new PlaylistChoice(PlaylistList.SelectedItems.OfType<PlaylistEntryDto>().ToList(), f)
            : null;

    public Dictionary<string, string>? Headers
    {
        get
        {
            var h = new Dictionary<string, string>();
            if (!string.IsNullOrWhiteSpace(AuthBox.Text)) h["Authorization"] = AuthBox.Text.Trim();
            if (!string.IsNullOrWhiteSpace(CookieBox.Text)) h["Cookie"] = CookieBox.Text.Trim();
            return h.Count > 0 ? h : null;
        }
    }

    private static bool IsSupported(string text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" or "ftp";

    private static bool IsWeb(string text) =>
        Uri.TryCreate(text, UriKind.Absolute, out var u) && u.Scheme is "http" or "https";

    private void UrlBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        var text = Url;
        var ok = IsSupported(text);
        IsPrimaryButtonEnabled = IsSecondaryButtonEnabled = ok;
        FindVideoButton.IsEnabled = IsWeb(text);
        UrlError.Text = text.Length > 0 && !ok ? "Enter a full http://, https:// or ftp:// link." : "";
        UrlError.Visibility = UrlError.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        ResetVideo(); // a different link invalidates any quality list
    }

    // --- video ---------------------------------------------------------------------

    private void ResetVideo()
    {
        _info = null;
        QualityBox.Visibility = Visibility.Collapsed;
        QualityBox.Items.Clear();
        PlaylistPanel.Visibility = Visibility.Collapsed;
        PlaylistList.ItemsSource = null;
        InstallToolsButton.Visibility = Visibility.Collapsed;
        VideoStatus.Text = "";
    }

    private void Busy(bool busy, string? text = null)
    {
        VideoRing.IsActive = busy;
        VideoRing.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        FindVideoButton.IsEnabled = !busy && IsWeb(Url);
        InstallToolsButton.IsEnabled = !busy;
        if (text is not null) VideoStatus.Text = text;
    }

    private async void FindVideo_Click(object sender, RoutedEventArgs e) => await FindVideoAsync();

    private async Task FindVideoAsync()
    {
        var url = Url;
        ResetVideo();
        Busy(true, "Looking for video…");
        try
        {
            var status = await _vm.MediaStatusAsync();
            if (status.YtDlp is null)
            {
                Busy(false, "Video downloading needs yt-dlp and ffmpeg. They are downloaded once and checked against published checksums.");
                InstallToolsButton.Visibility = Visibility.Visible;
                return;
            }

            var info = await _vm.MediaInfoAsync(url, Headers);
            if (url != Url) return; // the link changed while we were waiting
            _info = info;
            foreach (var f in info.Formats) QualityBox.Items.Add(f);
            QualityBox.SelectedIndex = 0;
            QualityBox.Visibility = Visibility.Visible;

            if (info.Playlist is { } list)
            {
                PlaylistList.ItemsSource = list.Entries;
                PlaylistList.SelectAll();
                PlaylistPanel.Visibility = Visibility.Visible;
                UpdatePlaylistCount();
            }

            var length = info.Duration is { } d ? $" ({TimeSpan.FromSeconds(d):h\\:mm\\:ss})" : "";
            var hint = "";
            if (!info.CanMerge)
            {
                hint = "\nffmpeg is missing, so only single-file qualities are listed.";
                InstallToolsButton.Visibility = Visibility.Visible;
            }
            var what = info.Playlist is { } pl
                ? $"Playlist: {info.Title} ({Videos(pl.Entries.Count)}{(pl.Truncated ? ", first 500 shown" : "")})"
                : $"{info.Title}{length}{(info.Uploader is { } u ? " — " + u : "")}";
            Busy(false, $"{what}{hint}\nChoose {(info.Playlist is null ? "a quality" : "the videos and a quality")}, then Download now or Add to queue.");
        }
        catch (Exception ex)
        {
            Busy(false, ex.Message.Length > 300 ? ex.Message[..300] + "…" : ex.Message);
        }
    }

    private static string Videos(int n) => n == 1 ? "1 video" : $"{n} videos";

    private void PlaylistAll_Click(object sender, RoutedEventArgs e) => PlaylistList.SelectAll();
    private void PlaylistNone_Click(object sender, RoutedEventArgs e) => PlaylistList.SelectedItems.Clear();
    private void Playlist_SelectionChanged(object sender, SelectionChangedEventArgs e) => UpdatePlaylistCount();

    private void UpdatePlaylistCount()
    {
        if (PlaylistCount is null || _info?.Playlist is null) return; // fires while the dialog is being built
        PlaylistCount.Text = $"{PlaylistList.SelectedItems.Count} of {Videos(_info.Playlist.Entries.Count)} selected";
    }

    private async void InstallTools_Click(object sender, RoutedEventArgs e)
    {
        Busy(true, "Installing…");
        try
        {
            await _vm.InstallMediaToolsAsync(text => VideoStatus.Text = text);
            InstallToolsButton.Visibility = Visibility.Collapsed;
            await FindVideoAsync();
        }
        catch (Exception ex)
        {
            Busy(false, "Install failed: " + ex.Message);
        }
    }

    // --- clipboard and folder ---------------------------------------------------------

    private async void Paste_Click(object sender, RoutedEventArgs e) => await TryPasteFromClipboardAsync(auto: false);

    private async Task TryPasteFromClipboardAsync(bool auto)
    {
        try
        {
            var content = Clipboard.GetContent();
            if (!content.Contains(StandardDataFormats.Text)) return;
            var text = (await content.GetTextAsync()).Trim();
            if (!IsSupported(text)) return;
            if (auto && Url.Length > 0) return;
            UrlBox.Text = text;
            ClipboardHint.Visibility = Visibility.Visible;
        }
        catch { /* clipboard busy or unavailable */ }
    }

    private async void Browse_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.Downloads };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(_owner));
        var folder = await picker.PickSingleFolderAsync();
        if (folder != null) FolderBox.Text = folder.Path;
    }
}
