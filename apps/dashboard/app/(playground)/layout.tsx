import { Providers } from "../providers";

export default function PlaygroundLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
