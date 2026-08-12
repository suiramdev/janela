import JanelaApp

/// The application entry point, and deliberately the only Swift file in the app
/// target.
///
/// `JanelaMain` is a `SwiftUI.App` living in `Packages/JanelaKit`. The `App`
/// protocol supplies a static `main()`, so this shell just calls it.
///
/// Everything else lives in the package, where it can be built and tested without
/// Xcode and reorganised without touching `project.yml`. If you are about to add a
/// second file here, ask whether it belongs in a module instead — the answer is
/// almost always yes.
@main
enum JanelaAppMain {
    static func main() {
        JanelaMain.main()
    }
}
