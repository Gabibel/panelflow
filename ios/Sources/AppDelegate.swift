import UIKit
import UserNotifications

/// Launch. Everything the app needs standing before the first screen appears,
/// in the order the pieces depend on each other.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Must happen before launch completes or iOS raises on the first
        // scheduled task.
        ChapterCheck.register()

        let shell = ShellViewController()
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = shell
        window.makeKeyAndVisible()
        self.window = window

        // The browser presents from the shell — set before anything can open a
        // link, including a notification tapped from a cold start.
        NativeMessages.presenter = shell

        UNUserNotificationCenter.current().delegate = self
        Notifications.requestPermission()

        // The worker is started before the rule list finishes compiling: the
        // library must load whether or not ad blocking is ready, and only the
        // browser needs the rules.
        WorkerHost.shared.start(backendURL: AppConfig.buildBackendURL)
        ContentBlocker.shared.compile { _ in }
        ChapterCheck.schedule()

        return true
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// The app being open is not a reason to swallow "chapter 110 is out" —
    /// the user may be reading something else entirely.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completion:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping () -> Void) {
        MainActor.assumeIsolated { Notifications.open(response) }
        completion()
    }
}
