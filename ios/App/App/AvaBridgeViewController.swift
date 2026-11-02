import UIKit
import AVFAudio
import Capacitor

class AvaBridgeViewController: CAPBridgeViewController {
    private var interruptionObserver: NSObjectProtocol?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AvaSecureStorePlugin())
        // WebKit handles recording permissions. An OS audio interruption must also
        // stop the JS voice session; it is resumed only by another explicit tap.
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            self?.webView?.evaluateJavaScript("window.dispatchEvent(new Event('ava:native-interruption'))", completionHandler: nil)
        }
    }

    deinit {
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
    }
}
