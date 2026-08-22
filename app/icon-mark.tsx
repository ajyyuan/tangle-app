export function IconMark({ apple = false }: { apple?: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: apple ? "#d84b45" : "transparent",
      }}
    >
      <div
        style={{
          width: apple ? 180 : 56,
          height: apple ? 180 : 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: apple ? 0 : 999,
          background: "#d84b45",
        }}
      >
        <svg
          width={apple ? 108 : 38}
          height={apple ? 108 : 38}
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="m3.25 8.25 3 3 6.5-6.5"
            stroke="#ffffff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
