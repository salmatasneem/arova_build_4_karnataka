import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || "An unexpected application error occurred.",
    };
  }

  render() {
    if (this.state.hasError) {
      let parsedError = this.state.message;
      try {
        const obj = JSON.parse(this.state.message) as {
          error?: string;
          operationType?: string;
          path?: string;
        };
        if (obj.error) {
          parsedError = `${obj.error} (operation: ${obj.operationType ?? "unknown"}, path: ${obj.path ?? "n/a"})`;
        }
      } catch {
        // Keep plain string message
      }

      return (
        <div className="min-h-screen bg-[#EEF2F2] arova-hero-mesh flex items-center justify-center p-6">
          <div className="max-w-lg w-full arova-glass-card rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 text-red-700">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
              <h2 className="text-lg font-semibold text-[#202525]">
                AROVA Application Error Encountered
              </h2>
            </div>
            <p className="text-sm text-[#737B7B] leading-relaxed break-words">{parsedError}</p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: "" })}
              className="arova-cta-primary inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Reload View
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
