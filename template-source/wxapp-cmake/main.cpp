#include <wx/wxprec.h>

#ifndef WX_PRECOMP
#include <wx/wx.h>
#endif

namespace
{
class MainFrame final : public wxFrame
{
public:
    MainFrame()
        : wxFrame(nullptr, wxID_ANY, "wxapp", wxDefaultPosition, wxSize(800, 600))
    {
#if defined(__WXMSW__)
        SetIcon(wxICON(app));
#endif

        auto* fileMenu = new wxMenu();
        fileMenu->Append(wxID_EXIT, "E&xit\tAlt-X");

        auto* helpMenu = new wxMenu();
        helpMenu->Append(wxID_ABOUT, "&About...\tF1");

        auto* menuBar = new wxMenuBar();
        menuBar->Append(fileMenu, "&File");
        menuBar->Append(helpMenu, "&Help");
        SetMenuBar(menuBar);

        Bind(wxEVT_MENU, &MainFrame::OnExit, this, wxID_EXIT);
        Bind(wxEVT_MENU, &MainFrame::OnAbout, this, wxID_ABOUT);

        CreateStatusBar();
        SetStatusText("Ready");
    }

private:
    void OnExit(wxCommandEvent&)
    {
        Close(true);
    }

    void OnAbout(wxCommandEvent&)
    {
        wxMessageBox("wxapp", "About", wxOK | wxICON_INFORMATION, this);
    }
};

class App final : public wxApp
{
public:
    bool OnInit() override
    {
        if (!wxApp::OnInit())
        {
            return false;
        }

        auto* frame = new MainFrame();
        frame->Show(true);
        return true;
    }
};
} // namespace

wxIMPLEMENT_APP(App);
