import Foundation
import Security
import Capacitor

/// Stores only the private Ava server connection. AI provider keys stay on the server.
@objc(AvaSecureStorePlugin)
public class AvaSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvaSecureStorePlugin"
    public let jsName = "AvaSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "Ava") + ".connection",
         kSecAttrAccount as String: "private-server-v1"]
    }

    @objc func load(_ call: CAPPluginCall) {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            call.reject("无法读取安全连接信息，请解锁设备后重试")
            return
        }
        call.resolve(["connection": value])
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let value = call.getObject("connection"),
              let origin = value["origin"] as? String,
              let url = URLComponents(string: origin), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let token = value["token"] as? String, token.count >= 32, token.count <= 4096,
              let consent = value["consentVersion"] as? Int, consent == 1,
              let data = try? JSONSerialization.data(withJSONObject: [
                "origin": origin, "token": token, "consentVersion": consent
              ]) else {
            call.reject("连接信息无效")
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            attributes.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { call.reject("无法安全保存连接信息"); return }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("无法清除连接信息"); return
        }
        call.resolve()
    }
}
