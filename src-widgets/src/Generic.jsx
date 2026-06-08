// Base class is provided by the vis-2 host at runtime as window.visRxWidget
// (shared via Module Federation). Do not import it from a package.
class Generic extends window.visRxWidget {
    static getI18nPrefix() {
        return "";
    }
}

export default Generic;
