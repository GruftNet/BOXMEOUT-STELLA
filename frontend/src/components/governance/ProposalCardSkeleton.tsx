export function ProposalCardSkeleton(): JSX.Element {
  return (
    <div className="p-5 bg-gray-900 border border-gray-800 rounded-xl space-y-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-5 w-16 bg-gray-700 rounded-full" />
        <div className="h-4 w-24 bg-gray-700 rounded" />
      </div>
      <div className="h-4 w-full bg-gray-700 rounded" />
      <div className="h-4 w-3/4 bg-gray-700 rounded" />
      <div className="flex items-center gap-4">
        <div className="h-3 w-32 bg-gray-700 rounded" />
        <div className="h-3 w-4 bg-gray-800 rounded" />
        <div className="h-3 w-24 bg-gray-700 rounded" />
      </div>
    </div>
  );
}
