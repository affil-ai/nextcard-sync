import "./welcome.css";

const openButton = document.getElementById("open-extension");
const panelStatus = document.getElementById("panel-status");
let browserWindowId: number | undefined;

if (openButton instanceof HTMLButtonElement) {
  void chrome.windows.getCurrent().then((browserWindow) => {
    browserWindowId = browserWindow.id;
    openButton.disabled = browserWindowId === undefined;
  }).catch(() => {
    if (panelStatus) panelStatus.textContent = "Open nextcard sync from Chrome’s puzzle-piece menu to get started.";
  });

  openButton.addEventListener("click", () => {
    if (browserWindowId === undefined) return;
    // Call directly within the click so Chrome retains the user gesture.
    void chrome.sidePanel.open({ windowId: browserWindowId }).then(() => {
      if (panelStatus) panelStatus.textContent = "nextcard sync is open beside this page. Follow the sign-in and Offers steps there.";
    }).catch(() => {
      if (panelStatus) panelStatus.textContent = "Could not open the panel. Click Chrome’s puzzle-piece icon, then nextcard sync.";
    });
  });
}
