using DownloadManager.Models;
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

    private readonly Window _owner;

    public AddDownloadDialog(Window owner, XamlRoot root, IEnumerable<CategoryDto> categories)
    {
        _owner = owner;
        InitializeComponent();
        XamlRoot = root;

        CategoryBox.Items.Add(new CategoryChoice(null, "Automatic (by file type)"));
        foreach (var c in categories) CategoryBox.Items.Add(new CategoryChoice(c.Id, c.Name));
        CategoryBox.SelectedIndex = 0;
        Loaded += async (_, _) => await TryPasteFromClipboardAsync(auto: true);
    }

    public string Url => UrlBox.Text.Trim();
    public int? CategoryId => (CategoryBox.SelectedItem as CategoryChoice)?.Id;
    public string? Folder => string.IsNullOrWhiteSpace(FolderBox.Text) ? null : FolderBox.Text.Trim();

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

    private void UrlBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        var text = Url;
        var ok = IsSupported(text);
        IsPrimaryButtonEnabled = IsSecondaryButtonEnabled = ok;
        UrlError.Text = text.Length > 0 && !ok ? "Enter a full http://, https:// or ftp:// link." : "";
        UrlError.Visibility = UrlError.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

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
