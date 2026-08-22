export default function LabLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="mb-lab-canvas" className="min-h-full bg-bg">
      {children}
    </div>
  );
}
