// Base class is provided by the vis-2 host at runtime as window.visRxWidget
// (shared via Module Federation). Do not import it from a package.

// Print once per bundle load. __WIDGET_VERSION__ is replaced by Vite define.
(function printBanner() {
    if (window.__boschWidgetBannerPrinted) return;
    window.__boschWidgetBannerPrinted = true;
    // eslint-disable-next-line no-console
    console.info(
        "%c BOSCH-SMART-HOME-CAMERA WIDGETS %c v" + __WIDGET_VERSION__ + " ",
        "color: #fff; background: #ea0016; font-weight: 700;",
        "color: #ea0016; background: #fff; font-weight: 700;",
    );
})();

class Generic extends window.visRxWidget {
    static getI18nPrefix() {
        return "";
    }
}

export default Generic;
