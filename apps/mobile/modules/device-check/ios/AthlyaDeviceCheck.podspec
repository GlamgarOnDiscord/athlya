Pod::Spec.new do |s|
  s.name           = 'AthlyaDeviceCheck'
  s.version        = '1.0.0'
  s.summary        = 'DeviceCheck device tokens for Athlya sign-in attestation'
  s.description    = 'Exposes DCDevice.generateToken to JavaScript for the device attestation headers on sign-in and registration.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Athlya'
  s.homepage       = 'https://github.com/GlamgarOnDiscord/athlya'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/GlamgarOnDiscord/athlya.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'DeviceCheck'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
