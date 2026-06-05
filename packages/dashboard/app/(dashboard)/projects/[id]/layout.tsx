export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div data-testid="project-detail" className="px-4 py-6 md:px-8 md:py-8">
      {children}
    </div>
  );
}
