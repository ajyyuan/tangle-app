const cards = [
  { title: "Choose a direction", left: 0, top: 22, emphasized: true },
  { title: "Handle what comes first", left: 100, top: 166 },
  { title: "Move forward", left: 20, top: 310 },
];

export function SocialPreview() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        overflow: "hidden",
        background: "#f8f8f7",
        color: "#202124",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          background: "linear-gradient(135deg, rgba(52,120,246,0.035), transparent 48%)",
        }}
      />
      <div
        style={{
          width: 650,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "70px 0 66px 74px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              background: "#3478f6",
            }}
          >
            <svg width="34" height="34" viewBox="0 0 16 16" fill="none">
              <path d="m3.25 8.25 3 3 6.5-6.5" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.6px" }}>Tangle</span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 68,
          }}
        >
          <div style={{ display: "flex", fontSize: 66, lineHeight: 1.02, fontWeight: 720, letterSpacing: "-3px" }}>
            Tasks, clearly connected.
          </div>
          <div style={{ display: "flex", width: 520, marginTop: 28, color: "#65686e", fontSize: 25, lineHeight: 1.35 }}>
            See what comes next—and what needs to happen first.
          </div>
        </div>
        <div style={{ display: "flex", marginTop: "auto", color: "#7c7f85", fontSize: 17 }}>
          Private by default · No account required
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 64,
          top: 72,
          width: 440,
          height: 430,
          display: "flex",
        }}
      >
        <svg width="440" height="430" viewBox="0 0 440 430" fill="none" style={{ position: "absolute", inset: 0 }}>
          <path d="M160 104V132H260V166" stroke="#a4a9b3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m252 154 8 12 8-12" stroke="#a4a9b3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M260 248V276H180V310" stroke="#a4a9b3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m172 298 8 12 8-12" stroke="#a4a9b3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {cards.map((card) => (
          <div
            key={card.title}
            style={{
              position: "absolute",
              left: card.left,
              top: card.top,
              width: 320,
              height: 82,
              display: "flex",
              alignItems: "center",
              gap: 15,
              padding: "0 22px",
              border: `2px solid ${card.emphasized ? "#b9cce8" : "#dedfdf"}`,
              borderRadius: 14,
              background: card.emphasized ? "#edf4ff" : "#ffffff",
              boxShadow: "0 5px 18px rgba(20,24,32,0.07)",
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                display: "flex",
                flex: "0 0 24px",
                border: `2px solid ${card.emphasized ? "#7ea8e7" : "#a6a8ad"}`,
                borderRadius: 999,
              }}
            />
            <span style={{ display: "flex", color: card.emphasized ? "#34363a" : "#65686e", fontSize: 19 }}>
              {card.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
