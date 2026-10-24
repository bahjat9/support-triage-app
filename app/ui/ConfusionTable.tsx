type Confusion = Record<string, Record<string, number>>;

export function ConfusionTable({ title, matrix }: { title: string; matrix: Confusion }) {
  const labels = Object.keys(matrix);
  return (
    <div className="confusion">
      <div className="small muted">{title}</div>
      <table>
        <thead>
          <tr>
            <th></th>
            {labels.map((l) => (
              <th key={l}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((exp) => (
            <tr key={exp}>
              <th>{exp}</th>
              {labels.map((pred) => {
                const v = matrix[exp]?.[pred] ?? 0;
                return (
                  <td key={pred} className={exp === pred ? "diag" : v > 0 ? "bad" : "muted"}>
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
