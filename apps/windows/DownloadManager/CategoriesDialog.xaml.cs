using DownloadManager.Models;
using DownloadManager.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;

namespace DownloadManager;

public sealed partial class CategoriesDialog : ContentDialog
{
    private readonly Window _owner;
    private readonly MainViewModel _vm;
    private List<CategoryDto> _items = [];
    private bool _loading;
    private int? _selectedId;
    private bool _creating;

    public CategoriesDialog(Window owner, XamlRoot root, MainViewModel vm)
    {
        _owner = owner;
        _vm = vm;
        InitializeComponent();
        XamlRoot = root;
        Loaded += async (_, _) => await ReloadAsync(null);
    }

    private CategoryDto? Selected => CategoryList.SelectedItem as CategoryDto;

    private async Task ReloadAsync(int? select)
    {
        try { _items = await _vm.ListCategoriesAsync(); }
        catch (Exception ex) { Say(ex.Message, true); return; }
        _loading = true;
        CategoryList.ItemsSource = _items;
        CategoryList.SelectedItem = _items.FirstOrDefault(c => c.Id == (select ?? _selectedId)) ?? _items.FirstOrDefault();
        _loading = false;
        Populate();
    }

    private void Category_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || Editor is null) return; // fires during construction
        _creating = false;
        Populate();
    }

    private void Populate()
    {
        var c = Selected;
        Editor.Visibility = c is null && !_creating ? Visibility.Collapsed : Visibility.Visible;
        DeleteButton.IsEnabled = c is not null && !_creating;
        if (_creating) return;
        if (c is null) return;
        _selectedId = c.Id;
        NameBox.Text = c.Name;
        ExtBox.Text = string.Join(' ', c.Extensions);
        FolderBox.Text = c.SaveDir ?? "";
        Say("", false);
    }

    private void Say(string text, bool error)
    {
        Status.Text = text;
        Status.Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[error ? "RoseBrush" : "EmeraldBrush"];
    }

    private void New_Click(object sender, RoutedEventArgs e)
    {
        _creating = true;
        _loading = true;
        CategoryList.SelectedItem = null;
        _loading = false;
        Editor.Visibility = Visibility.Visible;
        DeleteButton.IsEnabled = false;
        NameBox.Text = "";
        ExtBox.Text = "";
        FolderBox.Text = "";
        Say("Enter a name and the file types, then Save.", false);
        NameBox.Focus(FocusState.Programmatic);
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        var name = NameBox.Text.Trim();
        if (name.Length == 0) { Say("Give the category a name.", true); return; }
        var folder = string.IsNullOrWhiteSpace(FolderBox.Text) ? null : FolderBox.Text.Trim();
        if (folder is not null && !Path.IsPathRooted(folder)) { Say("The folder must be a full path, for example D:\\Videos.", true); return; }
        try
        {
            CategoryDto saved;
            if (_creating || Selected is null) saved = await _vm.AddCategoryAsync(name, ExtBox.Text, folder);
            else saved = await _vm.UpdateCategoryAsync(Selected.Id, name, ExtBox.Text, folder);
            _creating = false;
            _selectedId = saved.Id;
            await ReloadAsync(saved.Id);
            Say("Saved. New downloads of these types go to this category.", false);
        }
        catch (Exception ex)
        {
            Say(ex.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase) ? "A category with that name already exists." : ex.Message, true);
        }
    }

    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } c) return;
        try
        {
            await _vm.DeleteCategoryAsync(c.Id); // existing downloads keep their files; they just lose the label
            _selectedId = null;
            await ReloadAsync(null);
            Say($"Deleted “{c.Name}”.", false);
        }
        catch (Exception ex) { Say(ex.Message, true); }
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
