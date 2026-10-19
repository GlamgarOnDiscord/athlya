import DeviceCheck
import ExpoModulesCore

/// DeviceCheck token for the `x-device-attestation-token` header (issue #686).
/// The API validates it with Apple's `validate_device_token`.
public class AthlyaDeviceCheckModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AthlyaDeviceCheck")

    // False on the simulator and on devices without DeviceCheck.
    Constant("isSupported") {
      return DCDevice.current.isSupported
    }

    AsyncFunction("generateTokenAsync") { () -> String in
      let token = try await DCDevice.current.generateToken()
      return token.base64EncodedString()
    }
  }
}
