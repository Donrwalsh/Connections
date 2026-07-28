import { useEffect, useState } from "react";

export default function App() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/latest_date")
      .then(res => res.json())
      .then(setData)
      .catch(err => console.error("Error fetching backend:", err));
  }, []);

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>React Frontend</h1>
      <p>This is your Dockerized React app talking to NestJS.</p>

      <h2>Backend Response:</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
