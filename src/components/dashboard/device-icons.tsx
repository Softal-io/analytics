import {
  AndroidLogoIcon,
  AppleLogoIcon,
  BrowserIcon,
  DesktopIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  LinuxLogoIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react"
import {
  ChromeLogo,
  FirefoxLogo,
  MicrosoftEdgeLogo,
  SafariLogo,
  SamsungBrowserLogo,
} from "@/components/dashboard/icons"

export function BrowserMark({ browser }: { browser: string }) {
  let logo
  switch (browser) {
    case "Chrome":
      logo = <ChromeLogo />
      break
    case "Safari":
      logo = <SafariLogo />
      break
    case "Firefox":
      logo = <FirefoxLogo />
      break
    case "Edge":
    case "Microsoft Edge":
      logo = <MicrosoftEdgeLogo />
      break
    case "Samsung Internet":
    case "Samsung Browser":
      logo = <SamsungBrowserLogo />
      break
    default:
      logo = <BrowserIcon />
  }

  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center [&>svg]:size-5"
    >
      {logo}
    </span>
  )
}

export function OsMark({ os }: { os: string }) {
  const className = "size-5 shrink-0 text-kumo-subtle"
  switch (os) {
    case "Windows":
      return <WindowsLogoIcon className={className} weight="fill" />
    case "macOS":
    case "iOS":
      return <AppleLogoIcon className={className} weight="fill" />
    case "Android":
      return <AndroidLogoIcon className={className} weight="fill" />
    case "Linux":
      return <LinuxLogoIcon className={className} weight="fill" />
    default:
      return <DesktopIcon className={className} />
  }
}

export function DeviceMark({ device }: { device: string }) {
  const className = "size-5 shrink-0 text-kumo-subtle"
  if (device === "mobile") return <DeviceMobileIcon className={className} />
  if (device === "tablet") return <DeviceTabletIcon className={className} />
  return <DesktopIcon className={className} />
}
