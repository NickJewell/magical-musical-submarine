import { Link } from "wouter";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-6">
        <AlertCircle className="w-8 h-8 text-destructive" />
      </div>
      <h1 className="text-2xl font-serif text-primary-foreground mb-2">Lost in the dark</h1>
      <p className="text-muted-foreground mb-8">The coordinates you entered lead nowhere.</p>
      <Link href="/" className="text-primary hover:text-primary-foreground underline underline-offset-4 decoration-primary/50 transition-colors">
        Return to the surface
      </Link>
    </div>
  );
}
