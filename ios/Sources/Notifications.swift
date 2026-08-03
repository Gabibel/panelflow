import UIKit
import UserNotifications

/// "Chapter 110 is out." — the one thing the shared core cannot do for itself,
/// because a web view has no access to the notification centre.
///
/// The core decides *whether* to notify, and remembers, so a chapter never
/// announces itself twice. This only renders what it decided, and hands back
/// the tap.
@MainActor
enum Notifications {

    private static let category = "panelflow.chapter"

    static func requestPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    static func chapter(_ notification: [String: Any]) {
        let message = notification["message"] as? String ?? ""
        guard !message.isEmpty else { return }

        let content = UNMutableNotificationContent()
        content.title = (notification["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "PanelFlow"
        content.body = message
        content.sound = .default
        content.categoryIdentifier = category
        // Tapping it should land on the chapter, not on a generic home screen.
        if let entry = notification["entry"] as? [String: Any],
           let url = entry["sourceUrl"] as? String, url.hasPrefix("http") {
            content.userInfo = ["url": url]
        }

        // Delivered now, not scheduled: nil trigger fires immediately, and the
        // check that produced this already ran on its own timer.
        let id = notification["id"] as? String ?? UUID().uuidString
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    /// The tap. Called from the notification-centre delegate.
    static func open(_ response: UNNotificationResponse) {
        guard let url = response.notification.request.content.userInfo["url"] as? String
        else { return }
        _ = NativeMessages.handle(["type": "openUrl", "url": url])
    }
}
