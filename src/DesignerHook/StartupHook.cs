using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;

/// <summary>
/// .NET startup hook that AXAML Live loads into the Avalonia designer process (DOTNET_STARTUP_HOOKS).
/// In the preview's select mode, pointer input arrives with Alt+Control+Shift+Meta held: it is not passed to the
/// app; instead the control under the pointer is reported on stdout as "AXAML_LIVE {json}" with its path in the
/// logical tree (type name and index among siblings of that type) and the bounds of each element on the path.
/// Reflection only, so it works with Avalonia 11 and 12 without referencing either.
/// </summary>
internal static class StartupHook {
    // RawInputModifiers: Alt = 1, Control = 2, Shift = 4, Meta = 8
    const int SelectModifiers = 1 | 2 | 4 | 8;

    public static void Initialize() {
        if (Environment.GetEnvironmentVariable("AXAML_LIVE_DESIGNER_HOOK") != "1") {
            return;
        }

        new Thread(WaitForAvalonia) { IsBackground = true, Name = "AXAML Live designer hook" }.Start();
    }

    static void WaitForAvalonia() {
        // the input manager exists once the designer has initialized Avalonia
        for (int i = 0; i < 1200; i++) {
            try {
                if (Inspector.TrySubscribe()) {
                    return;
                }
            } catch (Exception e) {
                Console.Out.WriteLine("AXAML_LIVE {\"kind\":\"error\",\"message\":" + Json.String(e.Message) + "}");
                Console.Out.Flush();
                return;
            }
            Thread.Sleep(100);
        }
    }

    sealed class Inspector : IObserver<object> {
        readonly Assembly _base;
        readonly MethodInfo _hitTest;
        readonly MethodInfo _visualParent;
        readonly MethodInfo _translatePoint;
        readonly PropertyInfo _logicalChildren;
        readonly Type _visualType;
        readonly Type _styledElementType;
        readonly Type _pointType;
        readonly Type _inputElementType;
        readonly Dictionary<Type, Dictionary<string, PropertyInfo?>> _properties = new();
        string? _lastHover;

        Inspector(Assembly baseAssembly) {
            _base = baseAssembly;
            _visualType = Get("Avalonia.Visual");
            _styledElementType = Get("Avalonia.StyledElement");
            _pointType = Get("Avalonia.Point");
            var inputElement = _inputElementType = Get("Avalonia.Input.IInputElement");
            _hitTest = Get("Avalonia.Input.InputExtensions").GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == "InputHitTest" && m.GetParameters().Length == 2 && m.GetParameters()[0].ParameterType == inputElement
                    && m.GetParameters()[1].ParameterType == _pointType);
            _visualParent = Get("Avalonia.VisualTree.VisualExtensions").GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == "GetVisualParent" && !m.IsGenericMethod && m.GetParameters().Length == 1);
            _translatePoint = Get("Avalonia.VisualExtensions").GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == "TranslatePoint" && m.GetParameters().Length == 3);
            _logicalChildren = Get("Avalonia.LogicalTree.ILogical").GetProperty("LogicalChildren")!;
        }

        Type Get(string name) => _base.GetType(name, throwOnError: true)!;

        public static bool TrySubscribe() {
            var baseAssembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Avalonia.Base");
            var manager = baseAssembly?.GetType("Avalonia.Input.InputManager")
                ?.GetProperty("Instance", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);
            if (baseAssembly == null || manager == null) {
                return false;
            }

            var rawInput = baseAssembly.GetType("Avalonia.Input.Raw.RawInputEventArgs", throwOnError: true)!;
            var observable = typeof(IObservable<>).MakeGenericType(rawInput);
            var preProcess = manager.GetType().GetProperty("PreProcess")?.GetValue(manager)
                ?? observable.GetProperty("PreProcess")?.GetValue(manager);
            // IObserver<object> is an IObserver<RawInputEventArgs> (contravariance)
            observable.GetMethod("Subscribe")!.Invoke(preProcess, new object[] { new Inspector(baseAssembly) });
            Console.Out.WriteLine("AXAML_LIVE {\"kind\":\"ready\"}");
            Console.Out.Flush();
            return true;
        }

        public void OnNext(object e) {
            try {
                Handle(e);
            } catch (Exception ex) {
                Console.Out.WriteLine("AXAML_LIVE {\"kind\":\"error\",\"message\":" + Json.String(ex.Message) + "}");
                Console.Out.Flush();
            }
        }

        void Handle(object e) {
            var type = e.GetType();
            var modifiersValue = Prop(type, "InputModifiers")?.GetValue(e);
            var position = Prop(type, "Position")?.GetValue(e);
            if (modifiersValue == null || position == null || (Convert.ToInt32(modifiersValue, CultureInfo.InvariantCulture) & SelectModifiers) != SelectModifiers) {
                return;
            }

            // select mode: the app does not see this input
            Prop(type, "Handled")?.SetValue(e, true);
            var kind = Prop(type, "Type")?.GetValue(e)?.ToString();
            if (kind != "Move" && kind != "LeftButtonDown") {
                return;
            }

            var root = Prop(type, "Root")?.GetValue(e);
            // Avalonia 11: the root is the top-level; Avalonia 12: a PresentationSource with the top-level as RootElement
            if (root != null && !_inputElementType.IsInstanceOfType(root)) {
                root = Prop(root.GetType(), "RootElement")?.GetValue(root) ?? Prop(root.GetType(), "RootVisual")?.GetValue(root);
            }

            if (root == null) {
                return;
            }

            var hit = _hitTest.Invoke(null, new[] { root, position });
            var json = Describe(hit, root);
            var report = kind == "Move" ? "hover" : "select";
            if (report == "hover" && json == _lastHover) {
                return;
            }

            if (report == "hover") {
                _lastHover = json;
            }

            Console.Out.WriteLine("AXAML_LIVE {\"kind\":\"" + report + "\",\"path\":" + json + "}");
            Console.Out.Flush();
        }

        /// <summary>Path from the top-level to the user's control under the pointer (not template parts).</summary>
        string Describe(object? hit, object root) {
            // template parts belong to the control that applied the template: walk up to a control of the user's XAML
            var element = hit;
            while (element != null && _styledElementType.IsInstanceOfType(element) && Prop(element.GetType(), "TemplatedParent")?.GetValue(element) != null) {
                element = _visualParent.Invoke(null, new[] { element });
            }

            var chain = new List<object>();
            for (var e = element; e != null; e = Prop(e.GetType(), "Parent")?.GetValue(e)) {
                chain.Insert(0, e);
            }

            var sb = new StringBuilder("[");
            for (int i = 0; i < chain.Count; i++) {
                var e = chain[i];
                var name = e.GetType().Name;
                int tick = name.IndexOf('`');
                if (tick >= 0) {
                    name = name.Substring(0, tick);
                }

                int index = 0;
                if (i > 0 && _logicalChildren.GetValue(chain[i - 1]) is IEnumerable siblings) {
                    foreach (var s in siblings) {
                        if (ReferenceEquals(s, e)) {
                            break;
                        }

                        if (s?.GetType() == e.GetType()) {
                            index++;
                        }
                    }
                }

                if (i > 0) {
                    sb.Append(',');
                }

                // the full name finds the .axaml of a view (its x:Class) when the path continues inside it
                sb.Append("{\"type\":").Append(Json.String(name)).Append(",\"fullType\":").Append(Json.String(e.GetType().FullName ?? name))
                    .Append(",\"index\":").Append(index);
                AppendBounds(sb, e, root);
                sb.Append('}');
            }
            return sb.Append(']').ToString();
        }

        void AppendBounds(StringBuilder sb, object element, object root) {
            if (!_visualType.IsInstanceOfType(element) || !_visualType.IsInstanceOfType(root)) {
                return;
            }

            var origin = _translatePoint.Invoke(null, new[] { element, Activator.CreateInstance(_pointType, 0.0, 0.0), root });
            var bounds = Prop(element.GetType(), "Bounds")?.GetValue(element);
            if (origin == null || bounds == null) {
                return;
            }

            double X(object o, string p) => Convert.ToDouble(Prop(o.GetType(), p)!.GetValue(o), CultureInfo.InvariantCulture);
            sb.Append(",\"x\":").Append(Json.Number(X(origin, "X"))).Append(",\"y\":").Append(Json.Number(X(origin, "Y")))
                .Append(",\"width\":").Append(Json.Number(X(bounds, "Width"))).Append(",\"height\":").Append(Json.Number(X(bounds, "Height")));
        }

        PropertyInfo? Prop(Type type, string name) {
            if (!_properties.TryGetValue(type, out var map)) {
                _properties[type] = map = new Dictionary<string, PropertyInfo?>();
            }

            if (!map.TryGetValue(name, out var p)) {
                // the most derived public property of that name (some types hide a base property with "new")
                p = type.GetProperties(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(x => x.Name == name);
                map[name] = p;
            }
            return p;
        }

        public void OnError(Exception error) { }

        public void OnCompleted() { }
    }

    static class Json {
        public static string String(string s) {
            var sb = new StringBuilder("\"");
            foreach (var c in s) {
                if (c == '"' || c == '\\') {
                    sb.Append('\\').Append(c);
                } else if (c < ' ') {
                    sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                } else {
                    sb.Append(c);
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Number(double d) => double.IsNaN(d) || double.IsInfinity(d) ? "0" : d.ToString("0.##", CultureInfo.InvariantCulture);
    }
}
